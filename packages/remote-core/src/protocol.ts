/**
 * Daemon protocol message vocabulary (v1): JSON-RPC method/notification names
 * and their parameter/result shapes. This file is the SINGLE source of truth
 * for the wire contract between the dsh frontend (remote-daemon) and the
 * remote backend (remote-backend): both sides reference these constants and
 * types, never local string literals. All messages ride on the JSON-RPC layer
 * (jsonrpc.ts); `transfer.open` additionally opens a mux data channel
 * (mux.ts) for the bulk bytes.
 *
 * Identity: the backend assigns each authenticated connection a client id in
 * {@link HelloProofResult.clientId}. That id — nothing else — names the
 * write-control holder on the wire; clients NEVER send a self-chosen id.
 *
 * Event streams: `session.event` notifications carry the session's event
 * verbatim in seams `SessionEvent` shape (`{type, seq, time, data, …}`) inside
 * a {@link SessionEventEnvelope}. There is exactly one event shape on the
 * wire; event seqs are the session's own log positions (0-based, monotonic,
 * gaps mean events were missed).
 *
 * Errors: calls fail with JSON-RPC errors whose `data.remoteCode` carries a
 * RemoteErrorCode (see jsonrpc.ts). A `session.attach` rejected with
 * REMOTE_SESSION_LOCKED carries {@link SessionLockedErrorData} in
 * `data.remoteData`.
 */
import type { ChallengeMessage, HelloMessage } from './auth.js';

/** Daemon protocol version implemented by this package. */
export const PROTOCOL_VERSION = 1;

/** JSON-RPC method names (request/response). */
export const Methods = {
  /** F→B: handshake step 1, {@link HelloMessage} → {@link ChallengeMessage}. */
  Hello: 'hello',
  /** F→B: handshake step 3, {@link HelloProofParams} → {@link HelloProofResult}. */
  HelloProof: 'hello.proof',
  /** List sessions known to the daemon. */
  SessionList: 'session.list',
  /** Create a new session on the daemon. */
  SessionCreate: 'session.create',
  /** Attach to a session for reading and/or control. */
  SessionAttach: 'session.attach',
  /** Detach this client from a session. */
  SessionDetach: 'session.detach',
  /** Voluntarily release the write-control lock without detaching. */
  SessionControlRelease: 'session.control-release',
  /** Send prompt text to a session (requires write control). */
  SessionPrompt: 'session.prompt',
  /** Cancel the in-flight turn of a session. */
  SessionCancel: 'session.cancel',
  /** Fork a session at an optional event boundary. */
  SessionFork: 'session.fork',
  /** Read seq-paginated session history WITHOUT resuming the agent. */
  SessionHistory: 'session.history',
  /** Compact a session's context in place. */
  SessionCompact: 'session.compact',
  /** B→F: ask the frontend user to approve an action. */
  ApprovalRequest: 'approval.request',
  /** F→B: answer a pending approval request. */
  ApprovalAnswer: 'approval.answer',
  /** B→F: ask the frontend user one or more structured questions. */
  QuestionRequest: 'question.request',
  /** F→B: answer a pending question request. */
  QuestionAnswer: 'question.answer',
  /** List a catalog (models, skills, agent presets) known to the daemon. */
  CatalogList: 'catalog.list',
  /** Subscribe this connection to daemon metrics notifications. */
  MonitorSubscribe: 'monitor.subscribe',
  /** Stop this connection's daemon metrics subscription. */
  MonitorUnsubscribe: 'monitor.unsubscribe',
  /** Open a bulk-transfer data channel (upload/download). */
  TransferOpen: 'transfer.open',
} as const;

/** JSON-RPC notification names (no response). */
export const Notifications = {
  /** B→F: one session event, in per-session seq order. */
  SessionEvent: 'session.event',
  /** B→F: session lifecycle/status change. */
  SessionStatus: 'session.status',
  /** B→F: write-control holder changed. */
  SessionControlChanged: 'session.control-changed',
  /** B→F: periodic daemon metrics sample. */
  MonitorMetrics: 'monitor.metrics',
  /** B→F: an approval request was settled; unanswered clients stand down. */
  ApprovalClosed: 'approval.closed',
  /** B→F: a question request was settled; unanswered clients stand down. */
  QuestionClosed: 'question.closed',
} as const;

/** Attach mode: `read` tails events, `write` additionally takes control. */
export type AttachMode = 'read' | 'write';

/** Proof step of the handshake ({@link Methods.HelloProof}). */
export interface HelloProofParams {
  /** Client nonce from the original hello (echoed for binding). */
  clientNonce: string;
  /** Server nonce from the challenge. */
  serverNonce: string;
  /** The exact hello message previously sent. */
  hello: HelloMessage;
  /** HMAC proof from computeProof(). */
  proof: string;
}

/** Result of a successful proof exchange. */
export interface HelloProofResult {
  authenticated: true;
  /** Backend-assigned id of this client connection (used in control-lease fields). */
  clientId: string;
}

/**
 * Parameters for {@link Methods.SessionAttach}.
 *
 * Client identity is NOT a parameter: the backend names the write-control
 * holder by the client id it assigned in {@link HelloProofResult.clientId}.
 * (Frontends once sent a self-chosen `clientId` extension field here; it was
 * dropped — holder identity must be backend-authoritative.)
 */
export interface SessionAttachParams {
  sessionId: string;
  /** `read` subscribes to events; `write` also takes the control lock. */
  mode: AttachMode;
  /** Preempt the current write-control holder, if any. */
  force?: boolean;
  /**
   * Replay events starting AFTER this seq (strictly greater; `sinceSeq` is the
   * caller's delivery cursor, i.e. the last seq it already has). Omit to tail
   * "from now" (no replay).
   */
  sinceSeq?: number;
}

/** Result of {@link Methods.SessionAttach}. */
export interface SessionAttachResult {
  sessionId: string;
  /** Current write-control holder (backend-assigned client id), null when free. */
  holder: string | null;
  /** Highest event seq the session has emitted so far; -1 when the log is empty. */
  lastSeq: number;
  /**
   * Interactions (approvals, questions) still outstanding on the session at
   * attach time, so a (re)attaching client can replay their prompts. Absent
   * when none are pending or the backend does not advertise the
   * `pending-interactions` capability.
   */
  pendingInteractions?: PendingInteraction[];
}

/** `error.data.remoteData` of a REMOTE_SESSION_LOCKED attach failure. */
export interface SessionLockedErrorData {
  /** Client id currently holding write control, when known. */
  holder?: string;
  /** ISO-8601 time the current holder attached, when known. */
  attachedAt?: string;
}

/** One session as returned by {@link Methods.SessionList}. */
export interface SessionSummary {
  sessionId: string;
  /** Working directory of the session (empty string when the host does not track one). */
  cwd: string;
  /** Current lifecycle status. */
  status: SessionStatus;
  /** Number of clients currently attached. */
  attachedClients: number;
  /** Highest event seq emitted so far; -1 when the log is empty. */
  lastSeq: number;
  /** Backend-assigned client id holding write control, null when control is free. */
  controller: string | null;
  /** Human-readable title, when the host tracks one. Absent otherwise. */
  title?: string;
  /** Epoch milliseconds when the session was created; absent when the host does not report it. */
  createdAt?: number;
}

export interface SessionListResult {
  sessions: SessionSummary[];
}

/** Parameters for {@link Methods.SessionCreate}. All fields optional. */
export interface SessionCreateParams {
  /** Working directory for the new session (host default when omitted). */
  cwd?: string;
  /** Human-readable title (hosts without title support silently drop it). */
  title?: string;
}

/** Result of {@link Methods.SessionCreate}. */
export interface SessionCreateResult {
  /** Id of the freshly created session. */
  sessionId: string;
}

export interface SessionDetachParams {
  sessionId: string;
}

export interface SessionControlReleaseParams {
  sessionId: string;
}

/**
 * One content block of a structured prompt ({@link SessionPromptParams.content}).
 * Images travel base64-encoded, like transfer payloads.
 */
export type PromptContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; /** Base64-encoded image bytes. */ data: string; name?: string };

export interface SessionPromptParams {
  sessionId: string;
  /**
   * Plain-text prompt. Kept as the primary form for compatibility; backends
   * without the `prompt-blocks` capability see only this field.
   */
  text: string;
  /**
   * Structured prompt content (text + images), mirroring dsh's content-block
   * message shape. When present, `text` carries the plain-text projection for
   * peers without the `prompt-blocks` capability.
   */
  content?: PromptContentBlock[];
}

/**
 * Result of {@link Methods.SessionPrompt}: the backend-assigned id of the
 * queued user message. Always present — a backend that cannot mint one fails
 * the call instead of returning nothing.
 */
export interface SessionPromptResult {
  messageId: string;
}

export interface SessionCancelParams {
  sessionId: string;
}

export interface SessionForkParams {
  sessionId: string;
  /** Event seq to fork at; omit to fork at the current head. */
  boundary?: number;
  /**
   * Fork at a completed-turn boundary: the new session keeps the history up
   * to and including this seq, dropping everything after. This is the
   * protocol's rewind/time-travel semantic — there is deliberately no
   * `session.rewind` method. Requires the `fork-at-seq` capability.
   */
  atSeq?: number;
}

export interface SessionForkResult {
  /** Session id of the fork. */
  sessionId: string;
}

/** Parameters for {@link Methods.SessionHistory}. */
export interface SessionHistoryParams {
  sessionId: string;
  /**
   * Return only events with seq strictly below this cursor (the caller's
   * oldest known seq when paging backwards). Omit to start from the newest.
   */
  beforeSeq?: number;
  /** Maximum number of entries to return (backend may clamp). */
  maxMessages?: number;
}

/** One history entry: the event plus its log position, newest last. */
export interface SessionHistoryEntry {
  seq: number;
  event: WireSessionEvent;
}

/**
 * Result of {@link Methods.SessionHistory}: seq-paginated cold/hot history
 * WITHOUT resuming an agent. `entries` is ordered by ascending seq.
 */
export interface SessionHistoryResult {
  entries: SessionHistoryEntry[];
  /** True when older history remains before the first returned entry. */
  hasMore: boolean;
}

/** Parameters for {@link Methods.SessionCompact}. */
export interface SessionCompactParams {
  sessionId: string;
}

/**
 * Result of {@link Methods.SessionCompact}: whether the backend actually
 * compacted the session's context (false when it declined, e.g. mid-turn).
 */
export interface SessionCompactResult {
  compacted: boolean;
}

/** Lifecycle status of a daemon session. */
export type SessionStatus = 'idle' | 'running' | 'waiting-approval' | 'ended';

/**
 * One event in a session's history, as streamed to attached clients: the seams
 * `SessionEvent` shape, forwarded VERBATIM by the backend (core declares the
 * structural subset here to avoid depending on `@dsh-remote/seams`). `type`
 * names the event kind from the seams `SessionEventMap` vocabulary (e.g.
 * "user/message", "turn/start"); `data` is the type-specific payload. Events
 * may carry further seams fields (`ignorable`, surface metadata); receivers
 * must tolerate and pass them through.
 *
 * This is the ONLY event shape on the wire — the earlier loose
 * `{kind, text?, data?}` draft form was removed.
 */
export interface WireSessionEvent {
  /** Event type (seams `SessionEventMap` key). */
  type: string;
  /** Monotonic per-session sequence number (0-based log position). */
  seq: number;
  /** Unix epoch milliseconds. */
  time: number;
  /** Type-specific payload. */
  data?: unknown;
  /** Seams marker: a reader may safely skip this event when unrecognized. */
  ignorable?: true;
}

/**
 * Notification envelope for {@link Notifications.SessionEvent}: the routing
 * key plus the verbatim session event. The event's own `seq`/`time` are
 * authoritative (the envelope does not duplicate them).
 */
export interface SessionEventEnvelope {
  sessionId: string;
  event: WireSessionEvent;
}

/** Notification payload for {@link Notifications.SessionStatus}. */
export interface SessionStatusNotification {
  sessionId: string;
  status: SessionStatus;
}

/** Why the write-control holder changed. */
export type ControlChangeReason = 'acquired' | 'released' | 'preempted' | 'disconnected';

/** Notification payload for {@link Notifications.SessionControlChanged}. */
export interface SessionControlChangedNotification {
  sessionId: string;
  /** New write-control holder (client id), or null when control is free. */
  holder: string | null;
  reason: ControlChangeReason;
}

/** Parameters of {@link Methods.ApprovalRequest} (backend → frontend). */
export interface ApprovalRequestParams {
  /** Correlates with the eventual approval.answer. */
  requestId: string;
  sessionId: string;
  /** Approval kind, e.g. "exec" or "fs-write". */
  kind: string;
  /** Short human-readable summary of the action. */
  summary: string;
  /** Kind-specific details (command line, paths, …). */
  detail?: unknown;
}

/** Parameters of {@link Methods.ApprovalAnswer} (frontend → backend). */
export interface ApprovalAnswerParams {
  requestId: string;
  decision: 'approve' | 'deny';
  /** Optional user note recorded with the decision. */
  note?: string;
}

/**
 * Notification payload for {@link Notifications.ApprovalClosed}: the request
 * was settled by another client (or failed closed), so any client still
 * showing it should dismiss the prompt.
 */
export interface ApprovalClosedNotification {
  requestId: string;
  /** Decision that settled the request. */
  decision: 'approve' | 'deny';
  /** Client id whose answer won, absent on fail-closed denial. */
  winner?: string;
}

/** One selectable option of a {@link QuestionItem}. */
export interface QuestionOption {
  /** Stable option id, used as the answer value. */
  id: string;
  /** Human-readable label. */
  label: string;
  /** Longer explanation of the option, when available. */
  description?: string;
}

/**
 * One question of an ask-user-question request, modeled on dsh's
 * ask_user_question tool shape (question/items/options/answers).
 */
export interface QuestionItem {
  /** Stable item id, used as the answer-map key. */
  id: string;
  /** The question text shown to the user. */
  question: string;
  /** True when the user may select several options (answer value is an array). */
  multiSelect?: boolean;
  options: QuestionOption[];
}

/** Parameters of {@link Methods.QuestionRequest} (backend → frontend). */
export interface QuestionRequestParams {
  /** Correlates with the eventual question.answer. */
  questionId: string;
  sessionId: string;
  /** Short human-readable summary of why input is needed. */
  summary?: string;
  items: QuestionItem[];
}

/**
 * Parameters of {@link Methods.QuestionAnswer} (frontend → backend): the
 * answer map keyed by {@link QuestionItem.id}; each value is the chosen
 * {@link QuestionOption.id}, an array of ids for multi-select items, or
 * free-form text.
 */
export interface QuestionAnswerParams {
  questionId: string;
  answers: Record<string, string | string[]>;
}

/**
 * Notification payload for {@link Notifications.QuestionClosed}: the question
 * was settled by another client (or withdrawn), so any client still showing
 * it should dismiss the prompt.
 */
export interface QuestionClosedNotification {
  questionId: string;
  /** Answers that settled the question, absent when it was withdrawn. */
  answers?: Record<string, string | string[]>;
  /** Client id whose answer won, absent when withdrawn. */
  winner?: string;
}

/**
 * An interaction still outstanding on a session, replayed to (re)attaching
 * clients via {@link SessionAttachResult.pendingInteractions}. Carries the
 * same payloads (including stable ids) as the live
 * {@link Methods.ApprovalRequest} / {@link Methods.QuestionRequest} calls.
 */
export type PendingInteraction =
  | { kind: 'approval'; request: ApprovalRequestParams }
  | { kind: 'question'; request: QuestionRequestParams };

/** Catalog kind selectable in {@link Methods.CatalogList}. */
export type CatalogKind = 'models' | 'skills' | 'agentPresets';

/** Parameters for {@link Methods.CatalogList}. */
export interface CatalogListParams {
  kind: CatalogKind;
}

/** One model inside a {@link ModelProviderGroup}. */
export interface CatalogModel {
  /** Model id as passed to the provider. */
  id: string;
  /** Human-readable display name, when different from the id. */
  name?: string;
  /** Reasoning-effort options the model supports, when known. */
  reasoningEfforts?: string[];
  /** True when the model is routable (selectable) for this client. */
  routable?: boolean;
  /** True when this model is the daemon's current selection. */
  current?: boolean;
}

/** Models of one provider, as returned by the `models` catalog. */
export interface ModelProviderGroup {
  /** Provider id (e.g. "anthropic", "openai-compatible"). */
  provider: string;
  models: CatalogModel[];
}

/** One skill summary, as returned by the `skills` catalog. */
export interface SkillSummary {
  name: string;
  description?: string;
}

/** One agent-preset summary, as returned by the `agentPresets` catalog. */
export interface AgentPresetSummary {
  id: string;
  name: string;
  description?: string;
  /** True when this preset is the daemon's default. */
  isDefault: boolean;
}

/**
 * Result of {@link Methods.CatalogList}: a frontend-agnostic payload union
 * discriminated by the requested {@link CatalogKind}.
 */
export type CatalogListResult =
  | { kind: 'models'; providers: ModelProviderGroup[] }
  | { kind: 'skills'; skills: SkillSummary[] }
  | { kind: 'agentPresets'; agentPresets: AgentPresetSummary[] };

/** Parameters for {@link Methods.MonitorSubscribe}. */
export interface MonitorSubscribeParams {
  /** Push interval in milliseconds (backend clamps to a sane floor). */
  intervalMs?: number;
}

/** Notification payload for {@link Notifications.MonitorMetrics}. */
export interface MonitorMetricsNotification {
  /** ISO-8601 sample time. */
  ts: string;
  /** Live daemon sessions. */
  sessions: number;
  /** Clients currently attached across all sessions. */
  attachedClients: number;
  /** Process resident memory of the daemon, in bytes. */
  rssBytes?: number;
  /** 1/5/15-minute load averages (from /proc/loadavg). */
  loadAvg?: [number, number, number];
  /** Busy CPU ratio since the previous sample, 0..1 (from /proc/stat). */
  cpuBusyRatio?: number;
  /** Total system memory in bytes (MemTotal). */
  memTotalBytes?: number;
  /** Available system memory in bytes (MemAvailable). */
  memAvailableBytes?: number;
  /** Total bytes of the workspace filesystem (df). */
  diskTotalBytes?: number;
  /** Free bytes of the workspace filesystem (df). */
  diskFreeBytes?: number;
  /** Number of processes on the host. */
  processCount?: number;
}

/** Parameters for {@link Methods.TransferOpen}. */
export interface TransferOpenParams {
  /** `upload`: frontend → remote path; `download`: remote path → frontend. */
  direction: 'upload' | 'download';
  remotePath: string;
  /** Total byte size when known (uploads). */
  size?: number;
  /** Overwrite an existing remote file (uploads). */
  overwrite?: boolean;
}

/** Result of {@link Methods.TransferOpen}: the mux channel carrying the bytes. */
export interface TransferOpenResult {
  /** Mux channel id the transfer flows on (never CONTROL_CHANNEL). */
  channel: number;
}
