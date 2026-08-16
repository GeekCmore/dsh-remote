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
  /** B→F: request the frontend's hello (re-negotiation); same shapes as hello. */
  HelloChallenge: 'hello.challenge',
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
  /** B→F: ask the frontend user to approve an action. */
  ApprovalRequest: 'approval.request',
  /** F→B: answer a pending approval request. */
  ApprovalAnswer: 'approval.answer',
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

export interface SessionPromptParams {
  sessionId: string;
  text: string;
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
}

export interface SessionForkResult {
  /** Session id of the fork. */
  sessionId: string;
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
