/**
 * Public handle and client vocabulary of `@dsh-remote/client`: pure
 * TypeScript interfaces, cordis-free, and the SINGLE source of truth for the
 * daemon-mode frontend contract. `@dsh-remote/sessions` re-exports these
 * types and layers the cordis `Service` declaration on top; nothing here
 * imports cordis.
 *
 * Wire-level payload shapes (approval/question requests, prompt content
 * blocks, catalog results, …) are re-exported from `@dsh-remote/core` so
 * consumers never need to import two packages for one conversation.
 */
import type { SessionEvent } from '@dsh-remote/seams';
import type {
  ApprovalRequestParams,
  PromptContentBlock,
  QuestionRequestParams,
} from '@dsh-remote/core';

export type {
  AgentPresetSummary,
  ApprovalRequestParams,
  CatalogKind,
  CatalogListResult,
  CatalogModel,
  ControlChangeReason,
  ModelProviderGroup,
  PendingInteraction,
  PromptContentBlock,
  QuestionItem,
  QuestionOption,
  QuestionRequestParams,
  SkillSummary,
  WireSessionEvent,
} from '@dsh-remote/core';

import type { ControlChangeReason } from '@dsh-remote/core';

/** Attach mode: `read` tails events, `write` additionally takes the control lease. */
export type RemoteAttachMode = 'read' | 'write';

/** Lifecycle state of a remote session as seen by the frontend. */
export type RemoteSessionState =
  /** A live agent runtime backs the session right now. */
  | 'active'
  /** The session exists (persisted) but no live runtime is driving it. */
  | 'cold';

/** Coarse agent activity of one attached session. */
export type RemoteAgentStatus = 'running' | 'idle';

/**
 * One remote session as returned by `RemoteClient.list` /
 * `RemoteSessions.list`.
 */
export interface RemoteSessionSummary {
  sessionId: string;
  /** Human-readable title, when the backend tracks one. */
  title?: string;
  /**
   * Epoch milliseconds when the session was created. Backends that do not
   * report creation time yield `0`.
   */
  createdAt: number;
  /** Working directory of the session, when known. */
  cwd?: string;
  state: RemoteSessionState;
  /** At least one client is currently attached. */
  attached: boolean;
  /** Opaque id of the current write-control holder, when control is taken. */
  controller?: string;
}

/** Options for `RemoteClient.attach` / `RemoteSessions.attach`. */
export interface AttachOptions {
  /**
   * `read` (default) subscribes to the event stream; `write` additionally
   * takes the session's write-control lease, enabling {@link RemoteAgentHandle.prompt}.
   */
  mode?: RemoteAttachMode;
  /**
   * Preempt the current write-control holder. Only meaningful with
   * `mode: 'write'`; without it, attaching a write-controlled session fails
   * with `REMOTE_SESSION_LOCKED`.
   */
  force?: boolean;
}

/** Options for `RemoteClient.create` / `RemoteSessions.create`. */
export interface CreateRemoteSessionOptions {
  /** Working directory for the new session (backend default when omitted). */
  cwd?: string;
  /** Human-readable title for the new session. */
  title?: string;
}

/** Options for {@link RemoteAgentHandle.history} (seq-paginated, newest last). */
export interface HistoryOptions {
  /**
   * Return only events with seq strictly below this cursor (the caller's
   * oldest known seq when paging backwards). Omit to start from the newest.
   */
  beforeSeq?: number;
  /** Maximum number of entries to return (the backend may clamp further). */
  maxMessages?: number;
}

/** One history entry: the event plus its log position. */
export interface HistoryEntry {
  seq: number;
  event: SessionEvent;
}

/** Result of {@link RemoteAgentHandle.history}. */
export interface HistoryPage {
  /** Ordered by ascending seq. */
  entries: HistoryEntry[];
  /** True when older history remains before the first returned entry. */
  hasMore: boolean;
}

/** Options for {@link RemoteAgentHandle.fork}. */
export interface ForkOptions {
  /** Event seq to fork at (legacy boundary form); omit for the current head. */
  boundary?: number;
  /**
   * Fork at a completed-turn boundary: the fork keeps the history up to and
   * including this seq, dropping everything after (the protocol's
   * rewind/time-travel semantic). Requires the `fork-at-seq` capability.
   */
  atSeq?: number;
}

/** Structured prompt input: plain text plus optional content blocks. */
export interface PromptInput {
  /** Plain-text prompt (also the projection for peers without `prompt-blocks`). */
  text: string;
  /** Structured content (text + base64 images); requires the `prompt-blocks` capability. */
  content?: PromptContentBlock[];
}

/** Answer map for {@link RemoteAgentHandle.answerQuestion}, keyed by question item id. */
export type QuestionAnswers = Record<string, string | string[]>;

/**
 * Frontend façade over one attached remote agent session (tmux semantics).
 *
 * A handle is a local projection: the remote session outlives it. Dropping
 * the channel does not invalidate the handle — the implementation re-attaches
 * with `sinceSeq = lastSeq` and resumes delivery — but {@link detach} is
 * terminal and only ever detaches THIS client; the remote session is
 * unaffected.
 *
 * All `on*` registrations return an unsubscribe function. `onApproval` /
 * `onQuestion` additionally fire immediately for interactions that are still
 * pending at registration time (including ones replayed via the attach
 * result's `pendingInteractions`), so a subscriber can never miss a prompt
 * that predates its registration.
 */
export interface RemoteAgentHandle {
  /** Session this handle is attached to. */
  readonly sessionId: string;
  /**
   * Current attach mode. Starts as requested at attach time; downgrades to
   * `'read'` when the write lease is lost (preempted, released, or the holder
   * disconnected) and upgrades back on a successful write re-attach.
   */
  readonly mode: RemoteAttachMode;
  /**
   * Highest event seq delivered to (or skipped by) this handle. Doubles as
   * the reattach cursor: after a reconnect the backend replays from here, and
   * already-delivered seqs are de-duplicated before reaching `onEvent`.
   */
  readonly lastSeq: number;

  /**
   * Send a prompt to the session. Requires write control. The content-block
   * form additionally requires the backend's `prompt-blocks` capability.
   * @returns the id the backend assigned to the submitted message.
   * @throws `RemoteError` `REMOTE_SESSION_LOCKED` when this handle holds no
   *   write control; `REMOTE_CAPABILITY_UNSUPPORTED` for content blocks
   *   against a backend without `prompt-blocks`; `REMOTE_CONN_LOST` while the
   *   channel is down.
   */
  prompt(text: string): Promise<{ messageId: string }>;
  prompt(input: PromptInput): Promise<{ messageId: string }>;

  /** Cancel the in-flight turn of the session. */
  cancel(): Promise<void>;

  /**
   * Voluntarily release the write-control lease without detaching; the handle
   * downgrades to `mode: 'read'`. No-op for read-mode handles.
   */
  releaseControl(): Promise<void>;

  /**
   * Detach this client. Terminal for the handle; the remote session keeps
   * running and can be re-attached via `attach`.
   */
  detach(): Promise<void>;

  /** Coarse current agent activity. Unaffected by reconnects. */
  status(): RemoteAgentStatus;

  /**
   * Read seq-paginated session history WITHOUT resuming the agent. Requires
   * the backend's `history` capability.
   * @throws `RemoteError` `REMOTE_CAPABILITY_UNSUPPORTED` (fail-fast, no round
   *   trip) when the backend does not advertise `history`.
   */
  history(opts?: HistoryOptions): Promise<HistoryPage>;

  /**
   * Fork the session, optionally at a completed-turn boundary (`atSeq`,
   * requires the `fork-at-seq` capability).
   * @returns the session id of the fork.
   */
  fork(opts?: ForkOptions): Promise<{ sessionId: string }>;

  /**
   * Compact the session's context in place. Requires the `compact`
   * capability; the backend may decline (e.g. mid-turn), reported as
   * `{ compacted: false }`.
   */
  compact(): Promise<{ compacted: boolean }>;

  /**
   * Subscribe to approval requests addressed at this session. Fires for live
   * requests and, immediately at registration, for requests still pending
   * (including ones replayed from `pendingInteractions` on (re)attach).
   */
  onApproval(cb: (req: ApprovalRequestParams) => void): () => void;

  /**
   * Answer a pending approval request. Any attached client may answer; the
   * first answer wins and other clients are stood down via `approval.closed`.
   */
  answerApproval(requestId: string, decision: 'approve' | 'deny', note?: string): Promise<void>;

  /**
   * Subscribe to structured question requests addressed at this session
   * (same pending-replay semantics as {@link onApproval}). Requires the
   * backend's `questions` capability.
   * @throws `RemoteError` `REMOTE_CAPABILITY_UNSUPPORTED` when the backend
   *   does not advertise `questions`.
   */
  onQuestion(cb: (req: QuestionRequestParams) => void): () => void;

  /**
   * Answer a pending question request; first answer wins, other clients are
   * stood down via `question.closed`. Requires the `questions` capability.
   */
  answerQuestion(questionId: string, answers: QuestionAnswers): Promise<void>;

  /** Subscribe to session events, delivered in seq order, de-duplicated. */
  onEvent(cb: (e: SessionEvent) => void): () => void;
  /** Subscribe to coarse status changes. */
  onStatus(cb: (status: RemoteAgentStatus) => void): () => void;
  /**
   * Subscribe to write-control changes: `holder` is the new holder's opaque
   * client id (`null` when control is free) and `reason` says why it changed.
   */
  onControlChanged(cb: (holder: string | null, reason: ControlChangeReason) => void): () => void;
}

/**
 * The handle shape {@link RemoteClient} returns: the public
 * {@link RemoteAgentHandle} façade plus the internal-but-useful extras
 * (write escalation, detach state, owning target).
 */
export interface RemoteClientHandle extends RemoteAgentHandle {
  /** Target this handle's session lives on. */
  readonly targetId: string;
  /** True after {@link RemoteAgentHandle.detach} (or a failed re-attach). */
  readonly detached: boolean;
  /** Escalate a read handle to write control via a re-attach (dedup covers replay). */
  acquireWrite(force: boolean): Promise<void>;
}
