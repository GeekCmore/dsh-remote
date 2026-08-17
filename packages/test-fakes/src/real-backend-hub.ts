/**
 * E2E wiring: a `ctx.remoteHub` fake whose `transport.exec(backendCommand)`
 * returns an {@link ExecProcess} whose stdin/stdout are BytePipes connected to
 * a REAL `BackendServer` (remote-backend serve logic: real JSON-RPC framing,
 * real HMAC handshake, real SessionBroker/ApprovalBridge/MonitorCollector over
 * the in-memory host fakes). Same shape as `fake-hub.ts`, but the
 * spawned backend is the production implementation, not a re-implementation.
 *
 * Moved from `packages/remote-daemon/tests/e2e/real-backend-hub.ts`;
 * remote-proxy carried a byte-identical copy (modulo the header comment).
 *
 * One rig = one remote host: every exec spawn shares the same SessionBroker,
 * so reconnects and second clients see the same sessions and leases.
 */
import { Context } from '@deepseek-ai/cordis';
import {
  RemoteHub,
  type ConnectionStatus,
  type ExecProcess,
  type RemoteTarget,
  type RemoteTargetInfo,
  type RemoteTransport,
} from '@dsh-remote/remote';
import {
  ApprovalBridge,
  BackendServer,
  MonitorCollector,
  QuestionBridge,
  SessionBroker,
} from '@dsh-remote/backend';
import { BytePipe } from '@dsh-remote/test-utils';
import { FakeBackendTransport } from './backend-transport.js';
import {
  FakeAgentHost,
  FakeApprovalHost,
  FakeAttachments,
  FakeCatalogs,
  FakeCompaction,
  FakePersistence,
  FakeQuestionHost,
  FakeSessionHost,
  fakeMonitorSources,
} from './host-fakes.js';

export const E2E_TOKEN = 'e2e-pairing-token-0123456789abcdef';

/**
 * One remote host: the shared backend internals plus its live channels.
 * Wires the full protocol v2 subsystem set (persistence, questions, catalogs,
 * compaction, attachments), so the handshake advertises every capability.
 */
export class BackendRig {
  readonly sessions = new FakeSessionHost();
  readonly agents = new FakeAgentHost(this.sessions);
  readonly approvalHost = new FakeApprovalHost();
  readonly persistence = new FakePersistence();
  readonly questionHost = new FakeQuestionHost();
  readonly catalogs = new FakeCatalogs();
  readonly compaction = new FakeCompaction();
  readonly attachments = new FakeAttachments();
  readonly broker = new SessionBroker(this.sessions, this.agents, {
    persistence: this.persistence,
    compaction: this.compaction,
    attachments: this.attachments,
  });
  readonly approval = new ApprovalBridge(this.approvalHost, this.broker);
  readonly question = new QuestionBridge(this.questionHost, this.broker);
  readonly monitor = new MonitorCollector({
    workspacePath: '/work',
    stats: () => this.broker.stats(),
    sources: fakeMonitorSources(),
  });
  readonly diags: string[] = [];
  #channels: { toServer: BytePipe; fromServer: BytePipe }[] = [];
  #clientSeq = 0;

  /** Spawn a real BackendServer over a BytePipe pair; return the client-side process. */
  spawn(): ExecProcess {
    const toServer = new BytePipe();
    const fromServer = new BytePipe();
    const channel = { toServer, fromServer };
    this.#channels.push(channel);
    const server = new BackendServer({
      inbound: toServer,
      outbound: {
        send: (line) => {
          try {
            fromServer.push(line);
          } catch {
            // Client side already gone.
          }
        },
      },
      token: E2E_TOKEN,
      broker: this.broker,
      approval: this.approval,
      question: this.question,
      catalogs: this.catalogs,
      monitor: this.monitor,
      diag: (msg) => this.diags.push(msg),
      auth: { baseDelayMs: 1, maxDelayMs: 5, maxFailures: 3 },
      mintClientId: () => `client-${++this.#clientSeq}`,
      onFatal: () => this.endChannel(channel),
    });
    void server.closed.then(() => {
      this.#channels = this.#channels.filter((c) => c !== channel);
    });
    const stderr = new BytePipe();
    stderr.end();
    let resolveDone!: (v: { code: number | null; signal?: string }) => void;
    const done = new Promise<{ code: number | null; signal?: string }>((resolve) => {
      resolveDone = resolve;
    });
    return {
      stdout: fromServer,
      stderr,
      write: (data) => {
        try {
          toServer.push(typeof data === 'string' ? new TextEncoder().encode(data) : data);
        } catch {
          // Server side already gone.
        }
      },
      endStdin: () => toServer.end(),
      done,
      kill: async () => {
        this.endChannel(channel);
        resolveDone({ code: 0 });
      },
    };
  }

  /** Drop every live channel (network-loss simulation); backend state survives. */
  dropConnections(): void {
    for (const channel of [...this.#channels]) this.endChannel(channel);
  }

  liveChannelCount(): number {
    return this.#channels.length;
  }

  private endChannel(channel: { toServer: BytePipe; fromServer: BytePipe }): void {
    channel.toServer.end();
    channel.fromServer.end();
  }
}

/** `ctx.remoteHub` fake handing out rig-connected transports per target. */
export class RigRemoteHub extends RemoteHub {
  /** How many times `connect()` was called (initial connect + reconnects). */
  connectCalls = 0;
  backendCommand = 'dsh-remote-backend serve';
  private readonly rigs = new Map<string, { config: RemoteTarget; rig: BackendRig }>();

  constructor(ctx: Context) {
    super(ctx);
  }

  /** RigRemoteHub targets are registered together with their rig via addRig. */
  override addTarget(_config: RemoteTarget): string {
    throw new Error('RigRemoteHub: register targets with addRig (each target needs a BackendRig)');
  }

  /** Register a target backed by `rig`; returns the target id. */
  addRig(id: string, rig: BackendRig, pairingTokenRef?: string): string {
    const config: RemoteTarget = {
      id,
      ssh: { host: 'e2e.test', username: 'dsh', auth: { type: 'password', password: 'x' } },
      ...(pairingTokenRef !== undefined ? { pairingTokenRef } : {}),
    };
    this.rigs.set(id, { config, rig });
    return id;
  }

  rigOf(id: string): BackendRig {
    const entry = this.rigs.get(id);
    if (!entry) throw new Error(`unknown target: ${id}`);
    return entry.rig;
  }

  override async removeTarget(id: string): Promise<void> {
    this.rigs.delete(id);
  }

  override listTargets(): RemoteTargetInfo[] {
    return [...this.rigs.values()].map((entry) => ({
      id: entry.config.id ?? '',
      status: 'disconnected' as const,
    }));
  }

  override getTarget(id: string): RemoteTarget | undefined {
    return this.rigs.get(id)?.config;
  }

  override get(_id: string): RemoteTransport | undefined {
    return undefined;
  }

  override status(_id: string): ConnectionStatus {
    return 'disconnected';
  }

  override runtimeRoot(_id: string): string | undefined {
    return '/fake/runtime';
  }

  override connect(id: string): Promise<RemoteTransport> {
    const entry = this.rigs.get(id);
    if (!entry) return Promise.reject(new Error(`fake hub: unknown target: ${id}`));
    this.connectCalls++;
    const rig = entry.rig;
    return Promise.resolve(
      new FakeBackendTransport((): ExecProcess => rig.spawn(), this.backendCommand),
    );
  }

  override disconnect(_id: string): Promise<void> {
    return Promise.resolve();
  }
}
