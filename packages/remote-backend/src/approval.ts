/**
 * ApprovalBridge: routes the host's `approval/request` waterfall to attached
 * frontends and returns the first answer.
 *
 * Routing rules (per request):
 *
 * - the session has a write-control holder → the request goes ONLY to that
 *   client; its `approval.answer` settles the request;
 * - no writer → the request is broadcast to every client attached to the
 *   session; the first answer wins, and every other target receives an
 *   `approval.closed` notification so its prompt dismisses;
 * - nobody is attached → fail-closed by default: the request is denied with
 *   an "unavailable" note without ever reaching the host's remaining
 *   handlers. With `failClosed: false` the bridge delegates via `next()`.
 *
 * Waterfall semantics: the handler awaits the remote answer and RETURNS the
 * decision (owning the request), or returns `next()` to delegate — matching
 * upstream's waterfall conventions. While a request is pending the session is
 * flagged `waiting-approval` on the broker (list status + session.status
 * notification).
 */
import { randomBytes } from 'node:crypto';
import {
  Methods,
  Notifications,
  RemoteError,
  type ApprovalAnswerParams,
  type ApprovalClosedNotification,
  type ApprovalRequestParams,
} from '@dsh-remote/core';
import type { SessionBroker, BrokerConnection } from './broker.js';
import type {
  ApprovalHostAccess,
  HostApprovalDecision,
  HostApprovalRequest,
} from './host.js';

export interface ApprovalBridgeOptions {
  /** Deny when no frontend can answer (default true). */
  failClosed?: boolean;
}

interface PendingRequest {
  readonly requestId: string;
  readonly sessionId?: string;
  /** Clients still eligible to answer. */
  readonly targets: Set<string>;
  readonly resolve: (decision: HostApprovalDecision) => void;
}

export class ApprovalBridge {
  #broker: SessionBroker;
  #failClosed: boolean;
  #pending = new Map<string, PendingRequest>();
  #unsubscribeHost: () => void;

  constructor(host: ApprovalHostAccess, broker: SessionBroker, options: ApprovalBridgeOptions = {}) {
    this.#broker = broker;
    this.#failClosed = options.failClosed ?? true;
    this.#unsubscribeHost = host.onApprovalRequest((request, next) => this.#handle(request, next));
  }

  /** Detach from the host waterfall (plugin unload). */
  dispose(): void {
    this.#unsubscribeHost();
  }

  /** `approval.answer` from a frontend. */
  answer(clientId: string, params: ApprovalAnswerParams): void {
    const pending = this.#pending.get(params.requestId);
    if (!pending) {
      throw new RemoteError(
        'REMOTE_PROTOCOL_ERROR',
        `unknown or already-settled approval request "${params.requestId}"`,
      );
    }
    if (!pending.targets.has(clientId)) {
      throw new RemoteError(
        'REMOTE_PROTOCOL_ERROR',
        `client "${clientId}" is not a target of approval request "${params.requestId}"`,
      );
    }
    this.#settle(pending, { decision: params.decision, ...(params.note !== undefined ? { note: params.note } : {}) }, clientId);
  }

  /** A connection went away: it can no longer answer anything. */
  disconnect(clientId: string): void {
    for (const pending of [...this.#pending.values()]) {
      if (!pending.targets.delete(clientId)) continue;
      if (pending.targets.size === 0) {
        this.#settle(pending, { decision: 'deny', note: 'frontend disconnected before answering' });
      }
    }
  }

  /** Number of requests still awaiting an answer (tests/diagnostics). */
  get pendingCount(): number {
    return this.#pending.size;
  }

  async #handle(
    request: HostApprovalRequest,
    next: () => Promise<HostApprovalDecision>,
  ): Promise<HostApprovalDecision> {
    const sessionId = request.sessionId;
    const targets: BrokerConnection[] =
      sessionId !== undefined && this.#broker.writerOf(sessionId)
        ? [this.#broker.writerOf(sessionId)!]
        : sessionId !== undefined
          ? this.#broker.attachedTo(sessionId)
          : this.#broker.allConnections();
    if (targets.length === 0) {
      // Fail-closed: never silently fall through to host-local handlers when
      // the whole point of the bridge is that a REMOTE human must decide.
      if (this.#failClosed) {
        return { decision: 'deny', note: 'unavailable: no frontend attached' };
      }
      return next();
    }

    const requestId = `apr-${randomBytes(8).toString('hex')}`;
    const decisionPromise = new Promise<HostApprovalDecision>((resolve) => {
      this.#pending.set(requestId, {
        requestId,
        ...(sessionId !== undefined ? { sessionId } : {}),
        targets: new Set(targets.map((conn) => conn.clientId)),
        resolve,
      });
    });
    if (sessionId !== undefined) this.#broker.setWaitingApproval(sessionId, true);
    const params: ApprovalRequestParams = {
      requestId,
      sessionId: sessionId ?? '',
      kind: request.kind,
      summary: request.summary,
      ...(request.detail !== undefined ? { detail: request.detail } : {}),
    };
    for (const conn of targets) {
      try {
        conn.notify(Methods.ApprovalRequest, params);
      } catch {
        // Best-effort fan-out; a dead target settles via disconnect().
      }
    }
    try {
      return await decisionPromise;
    } finally {
      if (sessionId !== undefined) this.#broker.setWaitingApproval(sessionId, false);
    }
  }

  #settle(pending: PendingRequest, decision: HostApprovalDecision, winner?: string): void {
    if (!this.#pending.delete(pending.requestId)) return;
    const closed: ApprovalClosedNotification = {
      requestId: pending.requestId,
      decision: decision.decision,
      ...(winner !== undefined ? { winner } : {}),
    };
    for (const clientId of pending.targets) {
      if (clientId === winner) continue;
      const conn = this.#broker.allConnections().find((c) => c.clientId === clientId);
      try {
        conn?.notify(Notifications.ApprovalClosed, closed);
      } catch {
        // Best-effort.
      }
    }
    pending.resolve(decision);
  }
}
