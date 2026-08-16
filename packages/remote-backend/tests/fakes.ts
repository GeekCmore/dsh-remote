/**
 * Fully in-memory fakes of the host structural interfaces (host.ts) plus
 * wiring helpers that run the real BackendServer over a BytePipe pair.
 */
import {
  ChannelMux,
  JsonRpcPeer,
  RemoteError,
  computeProof,
  createHello,
  type ChallengeMessage,
  type HelloProofResult,
} from '@dsh-remote/core';
import { expect } from 'vitest';
import type { SessionEvent } from '@dsh-remote/seams';
import { ApprovalBridge } from '../src/approval.js';
import { SessionBroker, type BrokerConnection } from '../src/broker.js';
import type {
  AgentHostAccess,
  ApprovalHostAccess,
  ColdSessionInfo,
  HostAgent,
  HostApprovalDecision,
  HostApprovalRequest,
  HostSession,
  HostUserMessage,
  SessionHostAccess,
} from '../src/host.js';
import type { MonitorSources } from '../src/monitor.js';
import { MonitorCollector } from '../src/monitor.js';
import { BackendServer, type ServeAuthOptions, fanout } from '../src/serve.js';
import { TransferManager } from '../src/transfer.js';
import { pipePair } from './util.js';

export class FakeSession implements HostSession {
  readonly header: { createdAt: number; cwd?: string };
  events: SessionEvent[] = [];

  constructor(
    readonly id: string,
    header: { createdAt?: number; cwd?: string } = {},
  ) {
    this.header = { createdAt: header.createdAt ?? 1, cwd: header.cwd ?? '/work' };
  }

  get seq(): number {
    return this.events.length;
  }
}

export class FakeSessionHost implements SessionHostAccess {
  readonly sessions = new Map<string, FakeSession>();
  cold: ColdSessionInfo[] = [];
  #eventListeners: ((session: HostSession, event: SessionEvent) => void)[] = [];
  #disposedListeners: ((session: HostSession) => void)[] = [];

  add(id: string): FakeSession {
    const session = new FakeSession(id);
    this.sessions.set(id, session);
    return session;
  }

  /** `session.create` backing: mint an id and register a fresh session. */
  create(options: { cwd?: string; title?: string } = {}): FakeSession {
    const id = `created-${this.sessions.size + 1}`;
    const session = new FakeSession(id, {
      createdAt: Date.now(),
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    });
    this.sessions.set(id, session);
    return session;
  }

  /** Append a log-only event and publish it (like upstream Session.append). */
  emit(sessionId: string, type: string, data: unknown): SessionEvent {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`no such fake session ${sessionId}`);
    const event = {
      type,
      seq: session.events.length,
      time: 1_000 + session.events.length,
      data,
    } as unknown as SessionEvent;
    session.events.push(event);
    for (const listener of this.#eventListeners) listener(session, event);
    return event;
  }

  disposeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    for (const listener of this.#disposedListeners) listener(session);
  }

  get(id: string): HostSession | undefined {
    return this.sessions.get(id);
  }

  list(): HostSession[] {
    return [...this.sessions.values()];
  }

  fork(source: string, boundary?: number): HostSession {
    const src = this.sessions.get(source);
    if (!src) throw new Error(`session "${source}" not found`);
    const child = this.add(`${source}-fork-${this.sessions.size}`);
    const upto = boundary ?? src.events.length - 1;
    child.events = src.events.slice(0, upto + 1);
    return child;
  }

  onSessionEvent(listener: (session: HostSession, event: SessionEvent) => void): () => void {
    this.#eventListeners.push(listener);
    return () => {
      this.#eventListeners = this.#eventListeners.filter((l) => l !== listener);
    };
  }

  onSessionDisposed(listener: (session: HostSession) => void): () => void {
    this.#disposedListeners.push(listener);
    return () => {
      this.#disposedListeners = this.#disposedListeners.filter((l) => l !== listener);
    };
  }

  listCold(): ColdSessionInfo[] {
    return this.cold;
  }
}

export class FakeAgent implements HostAgent {
  status: 'idle' | 'running' = 'idle';
  prompts: HostUserMessage[] = [];
  cancelled = 0;

  constructor(readonly id: string) {}

  followup(message: HostUserMessage): void {
    this.prompts.push(message);
  }

  cancel(): void {
    this.cancelled += 1;
  }
}

export class FakeAgentHost implements AgentHostAccess {
  readonly agents = new Map<string, FakeAgent>();
  #statusListeners: ((agent: HostAgent, status: 'idle' | 'running') => void)[] = [];

  add(id: string): FakeAgent {
    const agent = new FakeAgent(id);
    this.agents.set(id, agent);
    return agent;
  }

  setStatus(id: string, status: 'idle' | 'running'): void {
    const agent = this.agents.get(id);
    if (!agent) throw new Error(`no such fake agent ${id}`);
    agent.status = status;
    for (const listener of this.#statusListeners) listener(agent, status);
  }

  get(id: string): HostAgent | undefined {
    return this.agents.get(id);
  }

  onStatus(listener: (agent: HostAgent, status: 'idle' | 'running') => void): () => void {
    this.#statusListeners.push(listener);
    return () => {
      this.#statusListeners = this.#statusListeners.filter((l) => l !== listener);
    };
  }
}

export class FakeApprovalHost implements ApprovalHostAccess {
  #handler:
    | ((req: HostApprovalRequest, next: () => Promise<HostApprovalDecision>) => Promise<HostApprovalDecision>)
    | undefined;
  /** Decisions returned when the bridge delegates via next(). */
  nextDecision: HostApprovalDecision = { decision: 'approve', note: 'host default' };
  nextCalls = 0;

  onApprovalRequest(
    handler: (req: HostApprovalRequest, next: () => Promise<HostApprovalDecision>) => Promise<HostApprovalDecision>,
  ): () => void {
    this.#handler = handler;
    return () => {
      this.#handler = undefined;
    };
  }

  /** Raise a host approval request; resolves with the waterfall result. */
  raise(request: HostApprovalRequest): Promise<HostApprovalDecision> {
    if (!this.#handler) throw new Error('no approval handler registered');
    return this.#handler(request, async () => {
      this.nextCalls += 1;
      return this.nextDecision;
    });
  }
}

/** Recording broker connection (broker/approval-level tests). */
export function fakeConnection(clientId: string): {
  conn: BrokerConnection;
  notifications: { method: string; params: unknown }[];
} {
  const notifications: { method: string; params: unknown }[] = [];
  return {
    conn: { clientId, notify: (method, params) => notifications.push({ method, params }) },
    notifications,
  };
}

/** Deterministic monitor sources for MonitorCollector tests. */
export function fakeMonitorSources(overrides: Partial<MonitorSources> = {}): MonitorSources {
  // /proc/stat jiffies must advance between samples for the CPU delta.
  let cpuSamples = 0;
  return {
    readProc: async (rel) => {
      if (rel === 'loadavg') return '0.50 1.00 1.50 2/123 456\n';
      if (rel === 'meminfo') return 'MemTotal:       1024 kB\nMemAvailable:    512 kB\n';
      if (rel === 'stat') {
        cpuSamples += 1;
        const busy = 200 + (cpuSamples - 1) * 30;
        const idle = 800 + (cpuSamples - 1) * 70;
        return `cpu  ${busy} 0 0 ${idle} 0 0 0 0 0 0\n`;
      }
      throw new Error(`unexpected proc read ${rel}`);
    },
    listProcEntries: async () => ['1', '2', '3', 'self', 'net'],
    df: async () => 'Filesystem     1024-blocks    Used Available Capacity Mounted on\n/dev/sda1           2048   1024      1024      50% /work\n',
    rssBytes: () => 12_345,
    ...overrides,
  };
}

export interface TestWorld {
  sessions: FakeSessionHost;
  agents: FakeAgentHost;
  approvalHost: FakeApprovalHost;
  broker: SessionBroker;
  approval: ApprovalBridge;
  monitor: MonitorCollector;
  transfer: TransferManager;
  server: BackendServer;
  client: JsonRpcPeer;
  clientMux: ChannelMux;
  clientInbound: import('./util.js').BytePipe;
  serverInbound: import('./util.js').BytePipe;
  fatalCount: () => number;
  diags: string[];
}

export const TEST_TOKEN = 'test-token-0123456789abcdef';

export interface WorldOptions {
  auth?: ServeAuthOptions;
  withTransfer?: boolean;
  monitorSources?: MonitorSources;
}

/** Run the real serve logic over a BytePipe pair against fake hosts. */
export function makeWorld(options: WorldOptions = {}): TestWorld {
  const { aIn, bIn } = pipePair();
  const sessions = new FakeSessionHost();
  const agents = new FakeAgentHost();
  const approvalHost = new FakeApprovalHost();
  const broker = new SessionBroker(sessions, agents);
  const approval = new ApprovalBridge(approvalHost, broker);
  const monitor = new MonitorCollector({
    workspacePath: '/work',
    stats: () => broker.stats(),
    sources: options.monitorSources ?? fakeMonitorSources(),
  });
  const diags: string[] = [];
  const transfer = new TransferManager({ diag: (msg) => diags.push(msg) });
  let fatal = 0;
  let clientSeq = 0;
  const server = new BackendServer({
    inbound: aIn,
    outbound: { send: (line) => bIn.push(line) },
    token: TEST_TOKEN,
    broker,
    approval,
    monitor,
    transfer,
    diag: (msg) => diags.push(msg),
    auth: { baseDelayMs: 1, maxDelayMs: 5, ...options.auth },
    mintClientId: () => `client-${++clientSeq}`,
    onFatal: () => {
      fatal += 1;
    },
  });
  const [rpcIn, muxIn] = fanout(bIn, 2);
  const client = new JsonRpcPeer({ send: (line) => aIn.push(line) }, rpcIn!);
  const clientMux = new ChannelMux({ send: (line) => aIn.push(line) }, muxIn!);
  return {
    sessions,
    agents,
    approvalHost,
    broker,
    approval,
    monitor,
    transfer,
    server,
    client,
    clientMux,
    clientInbound: bIn,
    serverInbound: aIn,
    fatalCount: () => fatal,
    diags,
  };
}

/** Drive the real handshake as a properly-paired frontend would. */
export async function handshake(client: JsonRpcPeer, token: string = TEST_TOKEN): Promise<HelloProofResult> {
  const hello = createHello();
  const challenge = (await client.call('hello', hello)) as ChallengeMessage;
  const proof = computeProof(token, hello.nonce, challenge.nonce, hello);
  return (await client.call('hello.proof', {
    clientNonce: hello.nonce,
    serverNonce: challenge.nonce,
    hello,
    proof,
  })) as HelloProofResult;
}

/** Expect a call to reject with a RemoteError carrying `code`. */
export async function expectRemoteError(
  call: Promise<unknown>,
  code: string,
): Promise<RemoteError> {
  try {
    await call;
  } catch (err) {
    expect(err).toBeInstanceOf(RemoteError);
    expect((err as RemoteError).code).toBe(code);
    return err as RemoteError;
  }
  throw new Error(`expected RemoteError ${code}, but the call resolved`);
}
