/**
 * Minimal structural interfaces for the host dsh runtime this plugin is
 * mounted into. The real dsh core packages (@deepseek-ai/dsh-session,
 * @deepseek-ai/dsh-agent) are not installable from npm, so this package never
 * imports them; instead it narrows the exact subset of `ctx.sessions` /
 * `ctx.agents` it needs into the structural types below and casts at the
 * plugin boundary (see index.ts). Upstream signatures (deepseek-harness
 * master, packages/core/session/src/index.ts and
 * packages/core/agent/src/{index,runtime-types}.ts):
 *
 * - SessionStore (`ctx.sessions`): `get(id: SessionId): Session | undefined`,
 *   `list(): Session[]`, `fork(source, boundary?, childSessionId?): Session`;
 *   event feed via `ctx.on('session/event', (session, event) => …)` and
 *   `ctx.on('session/disposed', (session) => …)`.
 * - Session: `id: SessionId` (branded string), `header: SessionHeader`
 *   (`cwd?`, `createdAt`, …), `events: readonly SessionEvent[]`,
 *   `seq: number` (next seq = log length).
 * - AgentRegistry (`ctx.agents`): `get(id): Agent | undefined`, `list()`;
 *   status feed via `ctx.on('agent/status', ({agent, status}) => …)`.
 * - Agent: `id`, `status: 'idle' | 'running'`,
 *   `followup(message: UserMessage): void`,
 *   `cancel(cause: AgentCancelCause, options?): void`.
 *
 * SessionEvent itself comes from @dsh-remote/seams (vendored upstream
 * definition), so event payloads cross this boundary without re-shaping.
 */
import type { SessionEvent } from '@dsh-remote/seams';

/**
 * The subset of an upstream `Session` the broker reads. `id` is a plain string
 * here; upstream it is the branded `SessionId` (a compile-time-only brand).
 */
export interface HostSession {
  readonly id: string;
  /** Upstream `session.header`; only the fields the broker reports. */
  readonly header: {
    readonly createdAt: number;
    readonly cwd?: string;
  };
  /** Upstream `session.events`: immutable snapshot of the append-only log. */
  readonly events: readonly SessionEvent[];
  /** Upstream `session.seq`: the next event's sequence number (= log length). */
  readonly seq: number;
}

/** A persisted session that is not currently live in the host store. */
export interface ColdSessionInfo {
  readonly id: string;
  readonly cwd?: string;
  /** Highest persisted event seq, when known. */
  readonly lastSeq?: number;
}

/**
 * The subset of `ctx.sessions` (upstream `SessionStore`) the broker uses.
 * Live sessions only; cold (persisted) sessions surface via the optional
 * {@link SessionHostAccess.listCold} hook, which a real deployment wires to
 * the session-persistence index.
 */
export interface SessionHostAccess {
  /** Upstream `SessionStore.get`. */
  get(id: string): HostSession | undefined;
  /** Upstream `SessionStore.list`: all live sessions, creation order. */
  list(): HostSession[];
  /**
   * Upstream `SessionStore.fork(source, boundary?)`: create a live child from
   * a stable prefix of a live source. Throws on unknown source or an invalid
   * boundary; the backend normalizes that to REMOTE_PROTOCOL_ERROR.
   */
  fork(source: string, boundary?: number): HostSession;
  /**
   * Create a fresh live session (`session.create` backing). OPTIONAL: not
   * every host supports ad-hoc session creation; when absent the backend
   * answers `session.create` with REMOTE_PROTOCOL_ERROR.
   */
  create?(options: { cwd?: string; title?: string }): HostSession;
  /**
   * Subscribe to the post-commit append feed (upstream
   * `ctx.on('session/event', …)`). Returns an unsubscribe disposer.
   */
  onSessionEvent(listener: (session: HostSession, event: SessionEvent) => void): () => void;
  /**
   * Subscribe to session teardown (upstream `ctx.on('session/disposed', …)`).
   * Optional: without it, attached clients are not told when a session ends.
   */
  onSessionDisposed?(listener: (session: HostSession) => void): () => void;
  /** Optional cold-session listing (persistence index); absent means none. */
  listCold?(): ColdSessionInfo[];
}

/**
 * A user prompt message as handed to `Agent.followup`. Structurally the
 * upstream `UserMessage` (id + role + content blocks + source); declared
 * loosely here because the dsh-llm types are not installable. The backend
 * builds `{ id, role: 'user', content: [{ type: 'text', text }], source }`.
 */
export interface HostUserMessage {
  id: string;
  role: 'user';
  content: unknown[];
  source: { kind: string };
}

/** The subset of an upstream `Agent` the broker drives. */
export interface HostAgent {
  /** Upstream `agent.id` — shared with the session id. */
  readonly id: string;
  /** Upstream `agent.status`. */
  readonly status: 'idle' | 'running';
  /** Upstream `agent.followup(message)`: queue a prompt turn and wake the driver. */
  followup(message: HostUserMessage): void;
  /** Upstream `agent.cancel({ kind: 'user' })`. */
  cancel(): void;
}

/** The subset of `ctx.agents` (upstream `AgentRegistry`) the broker uses. */
export interface AgentHostAccess {
  /** Upstream `AgentRegistry.get`. */
  get(id: string): HostAgent | undefined;
  /**
   * Subscribe to agent status transitions (upstream
   * `ctx.on('agent/status', ({ agent, status }) => …)`). Optional.
   */
  onStatus?(listener: (agent: HostAgent, status: 'idle' | 'running') => void): () => void;
}

/**
 * One approval request raised by the host's tool layer. In real dsh this
 * arrives through the `approval/request` waterfall (`ctx.on('approval/request',
 * (request, next) => …)`); the fields are the wire-facing subset.
 */
export interface HostApprovalRequest {
  /** Session the action belongs to, when the host attributes one. */
  sessionId?: string;
  /** Approval kind, e.g. "exec" or "fs-write". */
  kind: string;
  /** Short human-readable summary of the action. */
  summary: string;
  /** Kind-specific details (command line, paths, …). */
  detail?: unknown;
}

/** The decision the waterfall handler returns to the host. */
export interface HostApprovalDecision {
  decision: 'approve' | 'deny';
  /** Optional user note recorded with the decision. */
  note?: string;
}

/**
 * The host approval waterfall. The handler must await its answer and then
 * either return the decision (owning the request) or `return next()` to
 * delegate to the remaining handlers — the same short-circuit convention as
 * upstream's `agent/request` waterfall. Returns an unsubscribe disposer.
 */
export interface ApprovalHostAccess {
  onApprovalRequest(
    handler: (
      request: HostApprovalRequest,
      next: () => Promise<HostApprovalDecision>,
    ) => Promise<HostApprovalDecision>,
  ): () => void;
}
