/**
 * `dsh-remote-backend serve`: the stdio protocol server.
 *
 * stdout carries ONLY protocol traffic (one JSON line per frame — JSON-RPC
 * messages and mux data frames interleaved); every diagnostic goes to
 * stderr via the `diag` hook. stdin bytes are fanned out to both the
 * {@link JsonRpcPeer} and the {@link ChannelMux}; each layer ignores the
 * other's lines by construction (framing.ts).
 *
 * Handshake gate: until a client proves the pairing token, only `hello` and
 * `hello.proof` are answered — every other method is simply not registered
 * and falls to JSON-RPC -32601. Proof failures answer REMOTE_AUTH_FAILED
 * with an increasing delay (consecutive-failure rate limiting); after
 * `maxFailures` consecutive failures the server invokes `onFatal` (the
 * stdio entry point tears the stream down).
 */
import { randomBytes } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import {
  Capabilities,
  ChannelMux,
  JsonRpcPeer,
  Methods,
  RemoteError,
  createChallenge,
  type ApprovalAnswerParams,
  type CatalogListParams,
  type CatalogListResult,
  type ChallengeMessage,
  type HelloMessage,
  type HelloProofParams,
  type HelloProofResult,
  type MonitorSubscribeParams,
  type PendingInteraction,
  type QuestionAnswerParams,
  type SessionAttachParams,
  type SessionCancelParams,
  type SessionCompactParams,
  type SessionControlReleaseParams,
  type SessionCreateParams,
  type SessionDetachParams,
  type SessionForkParams,
  type SessionHistoryParams,
  type SessionPromptParams,
  type TransferOpenParams,
} from '@dsh-remote/core';
import { verifyProof } from '@dsh-remote/core';
import type { ApprovalBridge, ApprovalBridgeOptions } from './approval.js';
import { SessionBroker } from './broker.js';
import { loadToken } from './config.js';
import type {
  AgentHostAccess,
  ApprovalHostAccess,
  AttachmentsHostAccess,
  CatalogHostAccess,
  CompactionHostAccess,
  PersistenceHostAccess,
  QuestionHostAccess,
  SessionHostAccess,
} from './host.js';
import { MonitorCollector } from './monitor.js';
import { ApprovalBridge as ApprovalBridgeImpl } from './approval.js';
import { QuestionBridge } from './question.js';
import { TransferManager } from './transfer.js';

/** Auth failure rate-limit knobs. */
export interface ServeAuthOptions {
  /** Consecutive failures before the connection is dropped (default 3). */
  maxFailures?: number;
  /** Base delay per consecutive failure, in ms (default 500). */
  baseDelayMs?: number;
  /** Cap on the failure delay, in ms (default 5000). */
  maxDelayMs?: number;
}

export interface BackendServerDeps {
  /** Raw inbound byte stream (stdin side). */
  inbound: AsyncIterable<Uint8Array>;
  /** Protocol output hook (stdout side); diagnostics must NOT go here. */
  outbound: { send(line: Uint8Array): void };
  /** Pairing token from the backend config. */
  token: string;
  broker: SessionBroker;
  approval?: ApprovalBridge;
  question?: QuestionBridge;
  /** Read-only catalogs (`catalog.list`); absent → capability not advertised. */
  catalogs?: CatalogHostAccess;
  monitor?: MonitorCollector;
  transfer?: TransferManager;
  diag?: (message: string) => void;
  auth?: ServeAuthOptions;
  /** Invoked when auth failures exhaust the limit; the entry point tears down. */
  onFatal?: () => void;
  /** Client-id generator (tests may make it deterministic). */
  mintClientId?: () => string;
}

/** Fan one byte stream out to N independent async iterables. */
export function fanout(inbound: AsyncIterable<Uint8Array>, count: number): AsyncIterable<Uint8Array>[] {
  const queues: Uint8Array[][] = Array.from({ length: count }, () => []);
  const waiters: (((r: IteratorResult<Uint8Array>) => void) | null)[] = Array.from(
    { length: count },
    () => null,
  );
  let ended = false;
  void (async () => {
    try {
      for await (const chunk of inbound) {
        for (let i = 0; i < count; i++) {
          const waiter = waiters[i];
          if (waiter) {
            waiters[i] = null;
            waiter({ value: chunk, done: false });
          } else {
            queues[i]!.push(chunk);
          }
        }
      }
    } finally {
      ended = true;
      for (let i = 0; i < count; i++) {
        const waiter = waiters[i];
        if (waiter) {
          waiters[i] = null;
          waiter({ value: undefined, done: true });
        }
      }
    }
  })();
  return queues.map((queue, i) => ({
    async *[Symbol.asyncIterator]() {
      for (;;) {
        const head = queue.shift();
        if (head !== undefined) {
          yield head;
          continue;
        }
        if (ended) return;
        const next = await new Promise<IteratorResult<Uint8Array>>((resolve) => {
          waiters[i] = resolve;
        });
        if (next.done) return;
        yield next.value;
      }
    },
  }));
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * One authenticated-frontend connection of the daemon backend. Owns the
 * JSON-RPC peer and the channel mux sharing the byte stream, the handshake
 * state machine, and all method registrations.
 */
export class BackendServer {
  readonly peer: JsonRpcPeer;
  readonly mux: ChannelMux;
  #broker: SessionBroker;
  #approval?: ApprovalBridge;
  #question?: QuestionBridge;
  #catalogs?: CatalogHostAccess;
  #monitor?: MonitorCollector;
  #transfer?: TransferManager;
  /** Capability bits advertised on the challenge (derived from subsystems). */
  #capabilities: string[];
  #diag: (message: string) => void;
  #auth: Required<ServeAuthOptions>;
  #onFatal?: () => void;
  #mintClientId: () => string;
  #failures = 0;
  #clientId?: string;

  constructor(deps: BackendServerDeps) {
    this.#broker = deps.broker;
    this.#approval = deps.approval;
    this.#question = deps.question;
    this.#catalogs = deps.catalogs;
    this.#monitor = deps.monitor;
    this.#transfer = deps.transfer;
    this.#capabilities = computeCapabilities(deps);
    this.#diag = deps.diag ?? (() => {});
    this.#onFatal = deps.onFatal;
    this.#mintClientId = deps.mintClientId ?? (() => `client-${randomBytes(4).toString('hex')}`);
    this.#auth = {
      maxFailures: deps.auth?.maxFailures ?? 3,
      baseDelayMs: deps.auth?.baseDelayMs ?? 500,
      maxDelayMs: deps.auth?.maxDelayMs ?? 5_000,
    };
    const [rpcIn, muxIn] = fanout(deps.inbound, 2);
    this.peer = new JsonRpcPeer(deps.outbound, rpcIn!);
    this.mux = new ChannelMux(deps.outbound, muxIn!);
    if (deps.transfer) {
      const transfer = deps.transfer;
      this.mux.onChannel((channel) => {
        if (!transfer.handleChannel(channel)) {
          this.#diag(`mux channel ${channel.id} has no pending transfer; dropping`);
          channel.close();
        }
      });
    }

    // Handshake gate: only these two methods exist until proof succeeds.
    let pendingHello: { hello: HelloMessage; serverNonce: string } | undefined;
    this.peer.on(Methods.Hello, (params) => {
      const hello = params as HelloMessage;
      if (
        typeof hello?.nonce !== 'string' ||
        hello.protocolVersion !== 1 ||
        !Array.isArray(hello.capabilities)
      ) {
        throw new RemoteError('REMOTE_PROTOCOL_ERROR', 'malformed hello');
      }
      const challenge: ChallengeMessage = createChallenge(undefined, this.#capabilities);
      pendingHello = { hello, serverNonce: challenge.nonce };
      return challenge;
    });
    this.peer.on(Methods.HelloProof, async (params) => {
      const proof = params as HelloProofParams;
      if (!pendingHello) {
        throw new RemoteError('REMOTE_PROTOCOL_ERROR', 'hello required before hello.proof');
      }
      const ok =
        typeof proof?.proof === 'string' &&
        proof.clientNonce === pendingHello.hello.nonce &&
        proof.serverNonce === pendingHello.serverNonce &&
        verifyProof(deps.token, proof.clientNonce, proof.serverNonce, pendingHello.hello, proof.proof);
      if (!ok) {
        this.#failures += 1;
        await sleep(Math.min(this.#failures * this.#auth.baseDelayMs, this.#auth.maxDelayMs));
        if (this.#failures >= this.#auth.maxFailures) {
          this.#diag('authentication failure limit reached; closing connection');
          // Let the error response flush before the entry point tears down.
          const fatal = this.#onFatal;
          if (fatal) setTimeout(fatal, 25).unref();
        }
        throw new RemoteError('REMOTE_AUTH_FAILED', 'handshake proof verification failed');
      }
      pendingHello = undefined;
      const clientId = this.#mintClientId();
      this.#clientId = clientId;
      this.#registerMethods(clientId);
      this.#broker.connect({
        clientId,
        notify: (method, params) => this.peer.notify(method, params),
      });
      const result: HelloProofResult = { authenticated: true, clientId };
      return result;
    });

    void this.peer.closed.then(() => {
      const clientId = this.#clientId;
      if (!clientId) return;
      this.#broker.disconnect(clientId);
      this.#approval?.disconnect(clientId);
      this.#question?.disconnect(clientId);
      this.#monitor?.unsubscribe(clientId);
    });
  }

  /** Client id once authenticated (undefined before). */
  get clientId(): string | undefined {
    return this.#clientId;
  }

  /** Resolves when the byte stream ends and everything is torn down. */
  get closed(): Promise<void> {
    return this.peer.closed;
  }

  #registerMethods(clientId: string): void {
    const peer = this.peer;
    peer.on(Methods.SessionList, async () => ({ sessions: await this.#broker.list() }));
    peer.on(Methods.SessionCreate, (params) =>
      this.#broker.create(clientId, (params ?? {}) as SessionCreateParams),
    );
    peer.on(Methods.SessionAttach, (params) => {
      const p = params as SessionAttachParams;
      return this.#broker.attach(clientId, p, {
        pendingInteractions: this.#pendingInteractions(p.sessionId),
      });
    });
    peer.on(Methods.SessionDetach, (params) => {
      this.#broker.detach(clientId, (params as SessionDetachParams).sessionId);
      return null;
    });
    peer.on(Methods.SessionPrompt, (params) => {
      const p = params as SessionPromptParams;
      return this.#broker.prompt(clientId, p.sessionId, p.text, p.content);
    });
    peer.on(Methods.SessionCancel, (params) => {
      this.#broker.cancel(clientId, (params as SessionCancelParams).sessionId);
      return null;
    });
    peer.on(Methods.SessionFork, (params) => {
      const p = params as SessionForkParams;
      return this.#broker.fork(clientId, p.sessionId, p.boundary, p.atSeq);
    });
    peer.on(Methods.SessionHistory, (params) =>
      this.#broker.history((params ?? {}) as SessionHistoryParams),
    );
    peer.on(Methods.SessionCompact, (params) =>
      this.#broker.compact(clientId, (params as SessionCompactParams).sessionId),
    );
    peer.on(Methods.SessionControlRelease, (params) => {
      this.#broker.controlRelease(clientId, (params as SessionControlReleaseParams).sessionId);
      return null;
    });
    peer.on(Methods.ApprovalAnswer, (params) => {
      if (!this.#approval) {
        throw new RemoteError('REMOTE_CAPABILITY_UNSUPPORTED', 'this backend has no approval bridge');
      }
      this.#approval.answer(clientId, params as ApprovalAnswerParams);
      return null;
    });
    peer.on(Methods.QuestionAnswer, (params) => {
      if (!this.#question) {
        throw new RemoteError('REMOTE_CAPABILITY_UNSUPPORTED', 'this backend has no question bridge');
      }
      this.#question.answer(clientId, params as QuestionAnswerParams);
      return null;
    });
    peer.on(Methods.CatalogList, (params) => this.#catalogList(params as CatalogListParams));
    peer.on(Methods.MonitorSubscribe, (params) => {
      if (!this.#monitor) {
        throw new RemoteError('REMOTE_CAPABILITY_UNSUPPORTED', 'this backend has no monitor');
      }
      const p = (params ?? {}) as MonitorSubscribeParams;
      this.#monitor.subscribe(
        clientId,
        (method, payload) => this.peer.notify(method, payload),
        p.intervalMs,
      );
      return null;
    });
    peer.on(Methods.MonitorUnsubscribe, () => {
      this.#monitor?.unsubscribe(clientId);
      return null;
    });
    peer.on(Methods.TransferOpen, (params) => {
      if (!this.#transfer) {
        throw new RemoteError('REMOTE_CAPABILITY_UNSUPPORTED', 'this backend has no transfer endpoint');
      }
      return this.#transfer.open(params as TransferOpenParams);
    });
  }

  /**
   * Outstanding approvals/questions on a session, for the attach result.
   * Undefined (capability inactive) when neither bridge exists.
   */
  #pendingInteractions(sessionId: string): PendingInteraction[] | undefined {
    if (!this.#approval && !this.#question) return undefined;
    const out: PendingInteraction[] = [];
    for (const request of this.#approval?.pendingForSession(sessionId) ?? []) {
      out.push({ kind: 'approval', request });
    }
    for (const request of this.#question?.pendingForSession(sessionId) ?? []) {
      out.push({ kind: 'question', request });
    }
    return out;
  }

  /** `catalog.list`: read-only catalogs, gated per kind. */
  #catalogList(params: CatalogListParams): CatalogListResult {
    const catalogs = this.#catalogs;
    const unsupported = (kind: string) =>
      new RemoteError('REMOTE_CAPABILITY_UNSUPPORTED', `this backend has no ${kind} catalog`);
    switch (params?.kind) {
      case 'models': {
        const llm = catalogs?.llm;
        if (!llm) throw unsupported('models');
        return {
          kind: 'models',
          providers: llm.listProviders().map((provider) => ({
            provider: provider.id,
            models: llm.listModels(provider.id).map((model) => ({
              id: model.id,
              ...(model.name !== undefined ? { name: model.name } : {}),
              ...(model.reasoningEfforts !== undefined
                ? { reasoningEfforts: model.reasoningEfforts }
                : {}),
              ...(model.routable !== undefined ? { routable: model.routable } : {}),
              ...(model.current !== undefined ? { current: model.current } : {}),
            })),
          })),
        };
      }
      case 'skills': {
        const skills = catalogs?.skills;
        if (!skills) throw unsupported('skills');
        return {
          kind: 'skills',
          skills: skills.list().map((skill) => ({
            name: skill.name,
            ...(skill.description !== undefined ? { description: skill.description } : {}),
          })),
        };
      }
      case 'agentPresets': {
        const presets = catalogs?.agentPresets;
        if (!presets) throw unsupported('agentPresets');
        return {
          kind: 'agentPresets',
          agentPresets: presets.list().map((preset) => ({
            id: preset.id,
            name: preset.name,
            ...(preset.description !== undefined ? { description: preset.description } : {}),
            isDefault: preset.isDefault,
          })),
        };
      }
      default:
        throw new RemoteError('REMOTE_PROTOCOL_ERROR', `unknown catalog kind "${String(params?.kind)}"`);
    }
  }
}

/**
 * The capability set advertised on the challenge, computed from which
 * subsystems are present: the broker reports the host-derived bits
 * (history / compact / prompt-blocks, plus fork-at-seq which its contract
 * always honors); the server adds the bridge- and catalog-derived bits.
 */
function computeCapabilities(deps: BackendServerDeps): string[] {
  const caps = new Set(deps.broker.capabilities);
  if (deps.question) caps.add(Capabilities.Questions);
  if (deps.catalogs) caps.add(Capabilities.Catalogs);
  if (deps.approval || deps.question) caps.add(Capabilities.PendingInteractions);
  return [...caps];
}

/** Options for the real stdio entry point. */
export interface RunServeOptions {
  /** Config directory override; defaults per config.ts. */
  configDir?: string;
  sessions: SessionHostAccess;
  agents: AgentHostAccess;
  approvalHost?: ApprovalHostAccess;
  approval?: ApprovalBridgeOptions;
  /** Cold-session history (`session.history`); absent → capability off. */
  persistenceHost?: PersistenceHostAccess;
  /** ask_user_question provider registry; absent → capability off. */
  questionHost?: QuestionHostAccess;
  /** Read-only catalogs (`catalog.list`); absent → capability off. */
  catalogHost?: CatalogHostAccess;
  /** Context compaction (`session.compact`); absent → capability off. */
  compactionHost?: CompactionHostAccess;
  /** Image prompt blocks; absent → capability off. */
  attachmentsHost?: AttachmentsHostAccess;
  /** df target for the disk metric; defaults to process.cwd(). */
  workspacePath?: string;
  input?: Readable;
  output?: Writable;
  diag?: (message: string) => void;
  auth?: ServeAuthOptions;
}

/**
 * Wire everything onto real stdio and serve until the stream ends. stdout is
 * protocol-only; diagnostics go to stderr. Resolves when the connection
 * closes; sets `process.exitCode = 1` when it closed on an auth-failure
 * limit.
 */
export async function runServe(options: RunServeOptions): Promise<void> {
  const diag = options.diag ?? ((msg: string) => process.stderr.write(`${msg}\n`));
  const token = await loadToken(options.configDir);
  if (token === undefined) {
    diag('dsh-remote backend is not initialized; run `dsh-remote-backend init` first');
    process.exitCode = 1;
    return;
  }
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const broker = new SessionBroker(options.sessions, options.agents, {
    ...(options.persistenceHost !== undefined ? { persistence: options.persistenceHost } : {}),
    ...(options.compactionHost !== undefined ? { compaction: options.compactionHost } : {}),
    ...(options.attachmentsHost !== undefined ? { attachments: options.attachmentsHost } : {}),
  });
  const approval = options.approvalHost
    ? new ApprovalBridgeImpl(options.approvalHost, broker, options.approval)
    : undefined;
  const question = options.questionHost
    ? new QuestionBridge(options.questionHost, broker)
    : undefined;
  const monitor = new MonitorCollector({
    workspacePath: options.workspacePath ?? process.cwd(),
    stats: () => broker.stats(),
  });
  const transfer = new TransferManager({ diag });
  let fatal = false;
  const server = new BackendServer({
    inbound: input as AsyncIterable<Uint8Array>,
    outbound: { send: (line) => void output.write(Buffer.from(line)) },
    token,
    broker,
    ...(approval !== undefined ? { approval } : {}),
    ...(question !== undefined ? { question } : {}),
    ...(options.catalogHost !== undefined ? { catalogs: options.catalogHost } : {}),
    monitor,
    transfer,
    diag,
    ...(options.auth !== undefined ? { auth: options.auth } : {}),
    onFatal: () => {
      fatal = true;
      input.destroy();
    },
  });
  await server.closed;
  monitor.dispose();
  question?.dispose();
  approval?.dispose();
  if (fatal) process.exitCode = 1;
}
