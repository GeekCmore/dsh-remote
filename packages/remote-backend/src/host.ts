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
   *
   * `atSeq` is the protocol's fork-at-seq rewind semantic (keep history up to
   * and including that seq, drop everything after). Upstream's `boundary`
   * parameter is already an inclusive event boundary, so the index.ts
   * narrowing maps `atSeq` onto it when `boundary` is absent.
   */
  fork(source: string, boundary?: number, atSeq?: number): HostSession;
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
 * builds `{ id, role: 'user', content: [{ type: 'text', text }], source }`
 * for plain-text prompts; structured prompts (`session.prompt` with
 * `content` blocks) map image blocks to
 * `{ type: 'image', mediaType, name?, attachment }` where `attachment` is the
 * reference returned by {@link AttachmentsHostAccess.saveImage}.
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

/* ------------------------------------------------------------------------ */
/* Protocol v2 subsystems. All OPTIONAL: when the host lacks the underlying   */
/* service the narrowing is absent, the capability is not advertised, and a   */
/* wire call for it fails with REMOTE_CAPABILITY_UNSUPPORTED.                 */
/* ------------------------------------------------------------------------ */

/**
 * Cold-session history reads without resuming an agent. Narrows upstream
 * `ctx.sessionPersistence` (@deepseek-ai/dsh-session-persistence, class
 * `SessionPersistence`). Members may return promises; the broker awaits
 * either form.
 */
export interface PersistenceHostAccess {
  /** Upstream `SessionPersistence.inspect(id)`: metadata, undefined when unknown. */
  inspect(
    id: string,
  ): { id: string; lastSeq?: number } | undefined | Promise<{ id: string; lastSeq?: number } | undefined>;
  /**
   * Upstream `SessionPersistence.readFrom(id, fromSeq?)`: the persisted event
   * log starting at `fromSeq` (default 0), in ascending seq order.
   */
  readFrom(id: string, fromSeq?: number): readonly SessionEvent[] | Promise<readonly SessionEvent[]>;
  /** Upstream `SessionPersistence.list()`: every persisted session. */
  list(): ColdSessionInfo[] | Promise<ColdSessionInfo[]>;
}

/** One selectable option of a host question item (upstream ask_user_question shape). */
export interface HostQuestionOption {
  id: string;
  label: string;
  description?: string;
}

/** One question of a host ask-user-question request. */
export interface HostQuestionItem {
  id: string;
  question: string;
  multiSelect?: boolean;
  options: HostQuestionOption[];
}

/** A question request raised by the host's ask_user_question tool. */
export interface HostQuestionRequest {
  /** Session the question belongs to, when the host attributes one. */
  sessionId?: string;
  /** Short human-readable summary of why input is needed. */
  summary?: string;
  items: HostQuestionItem[];
}

/** Answer map keyed by item id; values are option ids or free-form text. */
export type HostQuestionAnswers = Record<string, string | string[]>;

/**
 * Narrows upstream `ctx.userQuestions`: `registerProvider({ ask })` installs
 * the ask_user_question provider and returns a disposer. Unlike the approval
 * waterfall there is no `next()` — the registered provider owns the tool —
 * so the question bridge is always fail-closed when no frontend can answer.
 */
export interface QuestionHostAccess {
  registerProvider(provider: {
    ask(request: HostQuestionRequest): Promise<HostQuestionAnswers>;
  }): () => void;
}

/** Narrows the read subset of upstream `ctx.llm` used by the models catalog. */
export interface CatalogLlmAccess {
  /** Upstream `ctx.llm.listProviders()`. */
  listProviders(): { id: string }[];
  /** Upstream `ctx.llm.listModels(providerId)`. */
  listModels(providerId: string): {
    id: string;
    name?: string;
    reasoningEfforts?: string[];
    routable?: boolean;
    current?: boolean;
  }[];
}

/** Narrows the read subset of upstream `ctx.skills`. */
export interface CatalogSkillsAccess {
  list(): { name: string; description?: string }[];
}

/** Narrows the read subset of upstream `ctx.agentPresets`. */
export interface CatalogAgentPresetsAccess {
  list(): { id: string; name: string; description?: string; isDefault: boolean }[];
}

/**
 * Read-only catalogs (`catalog.list`). Each member narrows one upstream
 * service and is independently optional: a host may have models but no
 * skills, so absence is reported per kind as REMOTE_CAPABILITY_UNSUPPORTED.
 */
export interface CatalogHostAccess {
  llm?: CatalogLlmAccess;
  skills?: CatalogSkillsAccess;
  agentPresets?: CatalogAgentPresetsAccess;
}

/**
 * Narrows upstream `ctx.compaction` (@deepseek-ai/dsh-compaction):
 * `compactNow(agent, signal)` compacts the agent's context in place.
 */
export interface CompactionHostAccess {
  compactNow(agent: HostAgent, signal?: AbortSignal): Promise<unknown>;
}

/** Reference to an image saved into the host's attachment store. */
export interface SavedImageAttachment {
  /** Host-assigned reference (id or path) usable in a message image block. */
  id: string;
}

/**
 * Narrows upstream `ctx.attachments`: `saveImage({ data, mediaType, name? })`
 * persists image bytes and returns the reference the agent's message content
 * blocks point at.
 */
export interface AttachmentsHostAccess {
  saveImage(input: {
    data: Uint8Array;
    mediaType: string;
    name?: string;
  }): Promise<SavedImageAttachment>;
}
