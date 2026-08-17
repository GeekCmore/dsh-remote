/**
 * {@link RemoteClientHandle} implementation backed by a {@link TargetConnection}:
 * a local projection of one attached remote session with tmux semantics —
 * detaching or dropping the channel never affects the remote session.
 *
 * Wire events arrive in the single protocol shape: seams `SessionEvent`
 * verbatim inside the envelope (see core `protocol.ts`), so delivery is a
 * cast, not an adaptation.
 *
 * Protocol v2 surface: `history` / `fork({atSeq})` / `compact` / structured
 * prompt content / approval + question wiring. Capability-gated features
 * check the backend-advertised set recorded by the handshake and fail fast
 * locally with REMOTE_CAPABILITY_UNSUPPORTED — no doomed round trip.
 * Outstanding approvals/questions are tracked in pending sets fed by the
 * request/closed notifications and by `pendingInteractions` replayed on
 * (re)attach; `onApproval`/`onQuestion` fire immediately for pending entries
 * at registration time, so a subscriber never misses a prompt that predates
 * it.
 */
import {
  Capabilities,
  Methods,
  Notifications,
  RemoteError,
  type ApprovalClosedNotification,
  type ApprovalRequestParams,
  type ControlChangeReason,
  type PendingInteraction,
  type QuestionClosedNotification,
  type QuestionRequestParams,
  type SessionAttachParams,
  type SessionAttachResult,
  type SessionCompactResult,
  type SessionEventEnvelope,
  type SessionForkResult,
  type SessionHistoryResult,
  type SessionPromptResult,
  type SessionStatus,
} from '@dsh-remote/core';
import type { SessionEvent } from '@dsh-remote/seams';
import type { SessionSubscriber, TargetConnection } from './connection.js';
import type {
  ForkOptions,
  HistoryOptions,
  HistoryPage,
  PromptInput,
  QuestionAnswers,
  RemoteAgentStatus,
  RemoteAttachMode,
  RemoteClientHandle,
} from './types.js';

/** Construction bundle for {@link DaemonAgentHandle} (internal to this package). */
export interface DaemonAgentHandleOptions {
  conn: TargetConnection;
  sessionId: string;
  mode: RemoteAttachMode;
  /** Attach-result head seq: the delivery cursor for a from-now attach. */
  initialLastSeq: number;
  /** Interactions still outstanding at attach time (replayed to subscribers). */
  pendingInteractions?: PendingInteraction[];
  /** Service-side bookkeeping run when the handle detaches. */
  onDetached(): void;
}

/** Map the backend lifecycle status onto the handle's coarse activity. */
function toAgentStatus(status: SessionStatus): RemoteAgentStatus {
  return status === 'running' || status === 'waiting-approval' ? 'running' : 'idle';
}

export class DaemonAgentHandle implements RemoteClientHandle, SessionSubscriber {
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
  private readonly approvalCbs = new Set<(req: ApprovalRequestParams) => void>();
  private readonly questionCbs = new Set<(req: QuestionRequestParams) => void>();
  /** Outstanding approval/question requests, keyed by their stable ids. */
  private readonly pendingApprovals = new Map<string, ApprovalRequestParams>();
  private readonly pendingQuestions = new Map<string, QuestionRequestParams>();
  /** Unsubscribers for the approval/question notification wiring. */
  private readonly unwire: Array<() => void>;

  constructor(opts: DaemonAgentHandleOptions) {
    this.conn = opts.conn;
    this.sessionId = opts.sessionId;
    this.mode = opts.mode;
    this.cursor = opts.initialLastSeq;
    this.onDetached = opts.onDetached;
    // Approval/question requests arrive as channel-level notifications (not
    // session-feed events); filter to this session and feed the pending sets.
    this.unwire = [
      this.conn.onDaemonNotification(Methods.ApprovalRequest, (p) => {
        const req = p as ApprovalRequestParams;
        if (req.sessionId === this.sessionId) this.addPendingApproval(req);
      }),
      this.conn.onDaemonNotification(Notifications.ApprovalClosed, (p) => {
        const n = p as ApprovalClosedNotification;
        this.pendingApprovals.delete(n.requestId);
      }),
      this.conn.onDaemonNotification(Methods.QuestionRequest, (p) => {
        const req = p as QuestionRequestParams;
        if (req.sessionId === this.sessionId) this.addPendingQuestion(req);
      }),
      this.conn.onDaemonNotification(Notifications.QuestionClosed, (p) => {
        const n = p as QuestionClosedNotification;
        this.pendingQuestions.delete(n.questionId);
      }),
    ];
    this.replayPending(opts.pendingInteractions);
  }

  get targetId(): string {
    return this.conn.targetId;
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

  prompt(text: string): Promise<{ messageId: string }>;
  prompt(input: PromptInput): Promise<{ messageId: string }>;
  async prompt(input: string | PromptInput): Promise<{ messageId: string }> {
    this.assertAttached();
    if (this.mode !== 'write') {
      throw new RemoteError(
        'REMOTE_SESSION_LOCKED',
        `session "${this.sessionId}": this handle holds no write control (read-mode attach)`,
      );
    }
    const text = typeof input === 'string' ? input : input.text;
    const content = typeof input === 'string' ? undefined : input.content;
    if (content !== undefined) {
      this.assertCapability(Capabilities.PromptBlocks, 'structured prompt content (prompt-blocks)');
    }
    const res = await this.conn.call<SessionPromptResult>(Methods.SessionPrompt, {
      sessionId: this.sessionId,
      text,
      ...(content !== undefined ? { content } : {}),
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
    for (const off of this.unwire) off();
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

  async history(opts: HistoryOptions = {}): Promise<HistoryPage> {
    this.assertAttached();
    this.assertCapability(Capabilities.History, 'session.history');
    const res = await this.conn.call<SessionHistoryResult>(Methods.SessionHistory, {
      sessionId: this.sessionId,
      ...(opts.beforeSeq !== undefined ? { beforeSeq: opts.beforeSeq } : {}),
      ...(opts.maxMessages !== undefined ? { maxMessages: opts.maxMessages } : {}),
    });
    return {
      entries: res.entries.map((e) => ({ seq: e.seq, event: e.event as unknown as SessionEvent })),
      hasMore: res.hasMore,
    };
  }

  async fork(opts: ForkOptions = {}): Promise<{ sessionId: string }> {
    this.assertAttached();
    if (opts.atSeq !== undefined) {
      this.assertCapability(Capabilities.ForkAtSeq, 'session.fork at a turn boundary (fork-at-seq)');
    }
    const res = await this.conn.call<SessionForkResult>(Methods.SessionFork, {
      sessionId: this.sessionId,
      ...(opts.boundary !== undefined ? { boundary: opts.boundary } : {}),
      ...(opts.atSeq !== undefined ? { atSeq: opts.atSeq } : {}),
    });
    return { sessionId: res.sessionId };
  }

  async compact(): Promise<{ compacted: boolean }> {
    this.assertAttached();
    this.assertCapability(Capabilities.Compact, 'session.compact');
    const res = await this.conn.call<SessionCompactResult>(Methods.SessionCompact, {
      sessionId: this.sessionId,
    });
    return { compacted: res.compacted };
  }

  onApproval(cb: (req: ApprovalRequestParams) => void): () => void {
    this.approvalCbs.add(cb);
    // Replay still-pending requests (attach/reattach replay included) so a
    // late subscriber never misses a prompt.
    for (const req of this.pendingApprovals.values()) cb(req);
    return () => {
      this.approvalCbs.delete(cb);
    };
  }

  async answerApproval(requestId: string, decision: 'approve' | 'deny', note?: string): Promise<void> {
    this.assertAttached();
    await this.conn.call(Methods.ApprovalAnswer, {
      requestId,
      decision,
      ...(note !== undefined ? { note } : {}),
    });
    this.pendingApprovals.delete(requestId);
  }

  onQuestion(cb: (req: QuestionRequestParams) => void): () => void {
    this.assertAttached();
    this.assertCapability(Capabilities.Questions, 'question requests (questions)');
    this.questionCbs.add(cb);
    for (const req of this.pendingQuestions.values()) cb(req);
    return () => {
      this.questionCbs.delete(cb);
    };
  }

  async answerQuestion(questionId: string, answers: QuestionAnswers): Promise<void> {
    this.assertAttached();
    this.assertCapability(Capabilities.Questions, 'question.answer (questions)');
    await this.conn.call(Methods.QuestionAnswer, { questionId, answers });
    this.pendingQuestions.delete(questionId);
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

  /**
   * A (re)attach succeeded: the result's `pendingInteractions` are the
   * authoritative outstanding set — replace the pending maps with it (when
   * carried) and fire callbacks for newly appearing interactions.
   */
  onReattached(result: SessionAttachResult): void {
    this.replayPending(result.pendingInteractions, { replace: true });
  }

  /**
   * Replay interactions still outstanding on the session (from an attach
   * result's `pendingInteractions`). Additive by default (initial attach);
   * `replace` (re-attach) first clears the pending sets, since the replayed
   * list is authoritative.
   */
  replayPending(interactions: PendingInteraction[] | undefined, opts: { replace?: boolean } = {}): void {
    if (this.detachedFlag) return;
    if (opts.replace) {
      this.pendingApprovals.clear();
      this.pendingQuestions.clear();
    }
    for (const p of interactions ?? []) {
      if (p.kind === 'approval') this.addPendingApproval(p.request);
      else this.addPendingQuestion(p.request);
    }
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
    for (const off of this.unwire) off();
    this.conn.unsubscribe(this);
    if (this.mode === 'write') {
      this.mode = 'read';
      for (const cb of [...this.controlCbs]) cb(null, 'disconnected');
    }
    this.onDetached();
  }

  private addPendingApproval(req: ApprovalRequestParams): void {
    if (this.detachedFlag || this.pendingApprovals.has(req.requestId)) return;
    this.pendingApprovals.set(req.requestId, req);
    for (const cb of [...this.approvalCbs]) cb(req);
  }

  private addPendingQuestion(req: QuestionRequestParams): void {
    if (this.detachedFlag || this.pendingQuestions.has(req.questionId)) return;
    this.pendingQuestions.set(req.questionId, req);
    for (const cb of [...this.questionCbs]) cb(req);
  }

  /**
   * Fail fast when the backend did not advertise `cap` in its handshake
   * challenge: better a local REMOTE_CAPABILITY_UNSUPPORTED than a doomed
   * round trip against a peer that cannot understand the call.
   */
  private assertCapability(cap: string, feature: string): void {
    if (!this.conn.capabilities.has(cap)) {
      throw new RemoteError(
        'REMOTE_CAPABILITY_UNSUPPORTED',
        `target "${this.conn.targetId}": backend does not support ${feature} (missing "${cap}" capability)`,
      );
    }
  }

  private assertAttached(): void {
    if (this.detachedFlag) {
      throw new RemoteError('REMOTE_ABORTED', `session "${this.sessionId}": handle is detached`);
    }
  }
}
