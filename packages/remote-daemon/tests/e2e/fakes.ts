/**
 * In-memory fakes of the remote-backend host structural interfaces, COPIED
 * from `packages/remote-backend/tests/fakes.ts` (that file is test-private
 * and not exported from the package; keep the two in sync when the host
 * interfaces change). Only the pieces the e2e harness needs are carried over:
 * FakeSessionHost / FakeAgentHost / FakeApprovalHost + deterministic monitor
 * sources.
 */
import type { SessionEvent } from '@dsh-remote/seams';
import type {
  AgentHostAccess,
  ApprovalHostAccess,
  ColdSessionInfo,
  HostAgent,
  HostApprovalDecision,
  HostApprovalRequest,
  HostSession,
  HostUserMessage,
  MonitorSources,
  SessionHostAccess,
} from '@dsh-remote/backend';

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

  /** Append a log event and publish it (like upstream Session.append). */
  emit(sessionId: string, type: string, data: unknown): SessionEvent {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`no such fake session ${sessionId}`);
    const event = {
      type,
      seq: session.events.length,
      time: Date.now(),
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

/** Deterministic monitor sources (no /proc, no df). */
export function fakeMonitorSources(): MonitorSources {
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
  };
}
