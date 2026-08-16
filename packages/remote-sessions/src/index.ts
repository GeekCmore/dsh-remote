/**
 * `@dsh-remote/sessions` — service definition for `ctx.remoteSessions`, the
 * daemon-mode session seam of dsh-remote.
 *
 * In daemon mode a complete dsh headless instance runs on the remote Linux
 * host and owns the real agent sessions; the local frontend attaches to them
 * over an SSH-carried JSON-RPC channel with tmux semantics:
 *
 * - attaching never disturbs the remote session — it only subscribes this
 *   client to the event stream (read) and optionally takes the write-control
 *   lease (write);
 * - detaching (or this process exiting) never disturbs the remote session
 *   either — the agent keeps running and can be re-attached later;
 * - attach is idempotent and re-entrant: attaching the same session twice
 *   yields the same handle, and a client recovering from a dropped channel
 *   re-attaches with its {@link RemoteAgentHandle.lastSeq} cursor so the
 *   backend replays exactly the events that were missed.
 *
 * Definition only: the abstract {@link RemoteSessions} class, the
 * {@link RemoteAgentHandle} façade, the summary/option vocabulary, and the
 * `Context`/`Events` augmentation. The daemon-protocol implementation lives
 * in `@dsh-remote/remote-daemon`.
 */

import { Context, Service } from '@deepseek-ai/cordis';
import type { RemoteError } from '@dsh-remote/core';
import type { SessionEvent } from '@dsh-remote/seams';

export type { ControlChangeReason } from '@dsh-remote/core';
import type { ControlChangeReason } from '@dsh-remote/core';

declare module '@deepseek-ai/cordis' {
  interface Context {
    remoteSessions: RemoteSessions;
  }

  interface Events {
    /**
     * The session set of a target changed: a session was created, ended, or
     * its attach/control state moved. Listeners typically re-run
     * {@link RemoteSessions.list}.
     * @mode emit
     */
    'remote/sessions-changed'(targetId: string): void;
  }
}

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
 * One remote session as returned by {@link RemoteSessions.list}.
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

/** Options for {@link RemoteSessions.attach}. */
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

/** Options for {@link RemoteSessions.create}. */
export interface CreateRemoteSessionOptions {
  /** Working directory for the new session (backend default when omitted). */
  cwd?: string;
  /** Human-readable title for the new session. */
  title?: string;
}

/**
 * Frontend façade over one attached remote agent session (tmux semantics).
 *
 * A handle is a local projection: the remote session outlives it. Dropping
 * the channel does not invalidate the handle — the implementation re-attaches
 * with `sinceSeq = lastSeq` and resumes delivery — but {@link detach} is
 * terminal and only ever detaches THIS client; the remote session is
 * unaffected.
 *
 * All `on*` registrations return an unsubscribe function.
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
   * Send prompt text to the session. Requires write control.
   * @returns the id the backend assigned to the submitted message.
   * @throws {@link RemoteError} `REMOTE_SESSION_LOCKED` when this handle holds
   *   no write control; `REMOTE_CONN_LOST` while the channel is down.
   */
  prompt(text: string): Promise<{ messageId: string }>;

  /** Cancel the in-flight turn of the session. */
  cancel(): Promise<void>;

  /**
   * Voluntarily release the write-control lease without detaching; the handle
   * downgrades to `mode: 'read'`. No-op for read-mode handles.
   */
  releaseControl(): Promise<void>;

  /**
   * Detach this client. Terminal for the handle; the remote session keeps
   * running and can be re-attached via {@link RemoteSessions.attach}.
   */
  detach(): Promise<void>;

  /** Coarse current agent activity. Unaffected by reconnects. */
  status(): RemoteAgentStatus;

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
 * Abstract remote-sessions provider, registered as `ctx.remoteSessions`.
 *
 * Implementations own the per-target backend channels and their reconnection;
 * consumers only see handles and summaries.
 */
export abstract class RemoteSessions extends Service {
  constructor(ctx: Context) {
    super(ctx, 'remoteSessions');
  }

  /** List the sessions a target's daemon knows about. */
  abstract list(targetId: string): Promise<RemoteSessionSummary[]>;

  /**
   * Attach to an existing session, idempotently: re-attaching a session this
   * service already serves yields the same handle (escalating its mode when a
   * write attach is requested on a read handle).
   *
   * @throws {@link RemoteError} `REMOTE_SESSION_LOCKED` when `mode: 'write'`
   *   is requested while another client holds the lease and `force` is not
   *   set; the error's `data` carries the holder when known.
   */
  abstract attach(targetId: string, sessionId: string, opts?: AttachOptions): Promise<RemoteAgentHandle>;

  /**
   * Create a new session on the target's daemon and attach to it. The fresh
   * handle starts in `mode: 'write'` (the creator presumably drives it).
   */
  abstract create(targetId: string, opts?: CreateRemoteSessionOptions): Promise<RemoteAgentHandle>;

  /**
   * Detach every handle this service serves — for one target, or across all
   * targets when `targetId` is omitted. Never affects the remote sessions.
   */
  abstract detachAll(targetId?: string): Promise<void>;
}

export default RemoteSessions;
