/**
 * {@link RemoteAgentHandle} implementation backed by a {@link TargetConnection}:
 * a local projection of one attached remote session with tmux semantics —
 * detaching or dropping the channel never affects the remote session.
 *
 * Wire events arrive in the single protocol shape: seams `SessionEvent`
 * verbatim inside the envelope (see core `protocol.ts`), so delivery is a
 * cast, not an adaptation.
 */
import {
  Methods,
  RemoteError,
  type ControlChangeReason,
  type SessionAttachParams,
  type SessionEventEnvelope,
  type SessionPromptResult,
  type SessionStatus,
} from '@dsh-remote/core';
import type { SessionEvent } from '@dsh-remote/seams';
import type {
  RemoteAgentHandle,
  RemoteAgentStatus,
  RemoteAttachMode,
} from '@dsh-remote/sessions';
import type { SessionSubscriber, TargetConnection } from './connection.js';

/** Construction bundle for {@link DaemonAgentHandle} (internal to this package). */
export interface DaemonAgentHandleOptions {
  conn: TargetConnection;
  sessionId: string;
  mode: RemoteAttachMode;
  /** Attach-result head seq: the delivery cursor for a from-now attach. */
  initialLastSeq: number;
  /** Service-side bookkeeping run when the handle detaches. */
  onDetached(): void;
}

/** Map the backend lifecycle status onto the handle's coarse activity. */
function toAgentStatus(status: SessionStatus): RemoteAgentStatus {
  return status === 'running' || status === 'waiting-approval' ? 'running' : 'idle';
}

export class DaemonAgentHandle implements RemoteAgentHandle, SessionSubscriber {
  readonly sessionId: string;
  mode: RemoteAttachMode;

  private readonly conn: TargetConnection;
  private readonly onDetached: () => void;
  private cursor: number;
  private currentStatus: RemoteAgentStatus = 'idle';
  private detachedFlag = false;
  private readonly eventCbs = new Set<(e: SessionEvent) => void>();
  private readonly statusCbs = new Set<(s: RemoteAgentStatus) => void>();
  private readonly controlCbs = new Set<(holder: string | null, reason: ControlChangeReason) => void>();

  constructor(opts: DaemonAgentHandleOptions) {
    this.conn = opts.conn;
    this.sessionId = opts.sessionId;
    this.mode = opts.mode;
    this.cursor = opts.initialLastSeq;
    this.onDetached = opts.onDetached;
  }

  get detached(): boolean {
    return this.detachedFlag;
  }

  /** Highest seq delivered (or confirmed skipped); the reattach cursor. */
  get lastSeq(): number {
    return this.cursor;
  }

  status(): RemoteAgentStatus {
    return this.currentStatus;
  }

  async prompt(text: string): Promise<{ messageId: string }> {
    this.assertAttached();
    if (this.mode !== 'write') {
      throw new RemoteError(
        'REMOTE_SESSION_LOCKED',
        `session "${this.sessionId}": this handle holds no write control (read-mode attach)`,
      );
    }
    const res = await this.conn.call<SessionPromptResult>(Methods.SessionPrompt, {
      sessionId: this.sessionId,
      text,
    });
    return { messageId: res.messageId };
  }

  async cancel(): Promise<void> {
    this.assertAttached();
    await this.conn.call(Methods.SessionCancel, { sessionId: this.sessionId });
  }

  async releaseControl(): Promise<void> {
    this.assertAttached();
    if (this.mode !== 'write') return;
    await this.conn.call(Methods.SessionControlRelease, { sessionId: this.sessionId });
    this.mode = 'read';
  }

  /**
   * Detach this client; terminal for the handle, harmless to the remote
   * session. A dead channel still completes the local teardown.
   */
  async detach(): Promise<void> {
    if (this.detachedFlag) return;
    this.detachedFlag = true;
    this.conn.unsubscribe(this);
    this.onDetached();
    try {
      await this.conn.call(Methods.SessionDetach, { sessionId: this.sessionId });
    } catch (err) {
      if (err instanceof RemoteError && err.code === 'REMOTE_CONN_LOST') return;
      throw err;
    }
  }

  /** Escalate a read handle to write control via a re-attach (dedup covers replay). */
  async acquireWrite(force: boolean): Promise<void> {
    this.assertAttached();
    if (this.mode === 'write') return;
    await this.conn.call(Methods.SessionAttach, {
      sessionId: this.sessionId,
      mode: 'write',
      sinceSeq: this.cursor,
      ...(force ? { force: true } : {}),
    });
    this.mode = 'write';
  }

  onEvent(cb: (e: SessionEvent) => void): () => void {
    this.eventCbs.add(cb);
    return () => this.eventCbs.delete(cb);
  }

  onStatus(cb: (status: RemoteAgentStatus) => void): () => void {
    this.statusCbs.add(cb);
    return () => this.statusCbs.delete(cb);
  }

  onControlChanged(cb: (holder: string | null, reason: ControlChangeReason) => void): () => void {
    this.controlCbs.add(cb);
    return () => this.controlCbs.delete(cb);
  }

  // --- SessionSubscriber (called by TargetConnection) ---

  reattachRequest(): SessionAttachParams {
    return { sessionId: this.sessionId, mode: this.mode, sinceSeq: this.cursor };
  }

  /** Dedup by seq cursor, then deliver in arrival (channel) order. */
  handleEvent(env: SessionEventEnvelope): void {
    if (this.detachedFlag || env.event.seq <= this.cursor) return;
    this.cursor = env.event.seq;
    const event = env.event as unknown as SessionEvent;
    for (const cb of [...this.eventCbs]) cb(event);
  }

  handleStatus(status: SessionStatus): void {
    if (this.detachedFlag) return;
    const mapped = toAgentStatus(status);
    if (mapped === this.currentStatus) return;
    this.currentStatus = mapped;
    for (const cb of [...this.statusCbs]) cb(mapped);
  }

  handleControl(holder: string | null, reason: ControlChangeReason): void {
    if (this.detachedFlag) return;
    const mine = holder !== null && holder === this.conn.clientId;
    if (this.mode === 'write' && !mine) this.mode = 'read';
    else if (mine && reason === 'acquired') this.mode = 'write';
    for (const cb of [...this.controlCbs]) cb(holder, reason);
  }

  /** The post-reconnect re-attach failed: tear the handle down locally. */
  onReattachFailed(_err: unknown): void {
    if (this.detachedFlag) return;
    this.detachedFlag = true;
    this.conn.unsubscribe(this);
    if (this.mode === 'write') {
      this.mode = 'read';
      for (const cb of [...this.controlCbs]) cb(null, 'disconnected');
    }
    this.onDetached();
  }

  private assertAttached(): void {
    if (this.detachedFlag) {
      throw new RemoteError('REMOTE_ABORTED', `session "${this.sessionId}": handle is detached`);
    }
  }
}
