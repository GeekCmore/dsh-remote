/**
 * QuestionBridge: routes the host's ask_user_question provider calls to
 * attached frontends and returns the first answer.
 *
 * Routing rules mirror {@link ApprovalBridge} exactly:
 *
 * - the session has a write-control holder → the request goes ONLY to that
 *   client; its `question.answer` settles the request;
 * - no writer → the request is broadcast to every client attached to the
 *   session; the first answer wins, and every other target receives a
 *   `question.closed` notification so its prompt dismisses;
 * - nobody is attached → fail-closed: the host's `ask` call REJECTS with an
 *   "unavailable" error (unlike the approval waterfall there is no `next()`
 *   to delegate to — the registered provider owns the tool).
 *
 * A target that disconnects mid-request is dropped; when the last target goes
 * away the request settles fail-closed the same way. Questions deliberately
 * do NOT touch the broker's waiting-approval status — a pending question does
 * not change the session's reported lifecycle status.
 */
import { randomBytes } from 'node:crypto';
import {
  Methods,
  Notifications,
  RemoteError,
  type QuestionAnswerParams,
  type QuestionClosedNotification,
  type QuestionRequestParams,
} from '@dsh-remote/core';
import type { SessionBroker, BrokerConnection } from './broker.js';
import type {
  HostQuestionAnswers,
  HostQuestionRequest,
  QuestionHostAccess,
} from './host.js';

interface PendingQuestion {
  readonly questionId: string;
  readonly sessionId?: string;
  /** Clients still eligible to answer. */
  readonly targets: Set<string>;
  /** The wire payload, kept for pendingInteractions replay. */
  readonly params: QuestionRequestParams;
  readonly resolve: (answers: HostQuestionAnswers) => void;
  readonly reject: (err: Error) => void;
  abort?: { signal: AbortSignal; listener: () => void };
}

export class QuestionBridge {
  #broker: SessionBroker;
  #pending = new Map<string, PendingQuestion>();
  #unsubscribeHost: () => void;

  constructor(host: QuestionHostAccess, broker: SessionBroker) {
    this.#broker = broker;
    this.#unsubscribeHost = host.registerProvider({
      ask: (request) => this.#ask(request),
    });
  }

  /** Detach from the host provider registry (plugin unload). */
  dispose(): void {
    this.#unsubscribeHost();
    for (const pending of [...this.#pending.values()]) {
      this.#withdraw(pending, new Error('question provider disposed before answering'));
    }
  }

  /** `question.answer` from a frontend. */
  answer(clientId: string, params: QuestionAnswerParams): void {
    const pending = this.#pending.get(params.questionId);
    if (!pending) {
      throw new RemoteError(
        'REMOTE_PROTOCOL_ERROR',
        `unknown or already-settled question request "${params.questionId}"`,
      );
    }
    if (!pending.targets.has(clientId)) {
      throw new RemoteError(
        'REMOTE_PROTOCOL_ERROR',
        `client "${clientId}" is not a target of question request "${params.questionId}"`,
      );
    }
    this.#settle(pending, params.answers, clientId);
  }

  /** A connection went away: it can no longer answer anything. */
  disconnect(clientId: string): void {
    for (const pending of [...this.#pending.values()]) {
      if (!pending.targets.delete(clientId)) continue;
      if (pending.targets.size === 0) {
        this.#withdraw(pending, new Error('frontend disconnected before answering'));
      }
    }
  }

  /** Outstanding questions on one session (session.attach pendingInteractions). */
  pendingForSession(sessionId: string): QuestionRequestParams[] {
    const out: QuestionRequestParams[] = [];
    for (const pending of this.#pending.values()) {
      if (pending.sessionId === sessionId) out.push(pending.params);
    }
    return out;
  }

  /** Number of requests still awaiting an answer (tests/diagnostics). */
  get pendingCount(): number {
    return this.#pending.size;
  }

  async #ask(request: HostQuestionRequest): Promise<HostQuestionAnswers> {
    if (request.signal?.aborted) {
      throw new Error('ask_user_question aborted before frontend answered');
    }
    const sessionId = request.sessionId;
    const targets: BrokerConnection[] =
      sessionId !== undefined && this.#broker.writerOf(sessionId)
        ? [this.#broker.writerOf(sessionId)!]
        : sessionId !== undefined
          ? this.#broker.attachedTo(sessionId)
          : this.#broker.allConnections();
    if (targets.length === 0) {
      // Fail-closed: never pretend the user answered when no REMOTE human
      // could have seen the question.
      throw new Error('unavailable: no frontend attached');
    }

    const questionId = `qst-${randomBytes(8).toString('hex')}`;
    const params: QuestionRequestParams = {
      questionId,
      sessionId: sessionId ?? '',
      ...(request.summary !== undefined ? { summary: request.summary } : {}),
      items: request.items.map((item) => ({
        id: item.id,
        question: item.question,
        ...(item.detail !== undefined ? { detail: item.detail } : {}),
        ...(item.header !== undefined ? { header: item.header } : {}),
        ...(item.multiSelect !== undefined ? { multiSelect: item.multiSelect } : {}),
        ...(item.intent !== undefined ? { intent: item.intent } : {}),
        options: item.options,
      })),
    };
    let resolveAnswer!: (answers: HostQuestionAnswers) => void;
    let rejectAnswer!: (err: Error) => void;
    const answerPromise = new Promise<HostQuestionAnswers>((resolve, reject) => {
      resolveAnswer = resolve;
      rejectAnswer = reject;
    });
    const pending: PendingQuestion = {
      questionId,
      ...(sessionId !== undefined ? { sessionId } : {}),
      targets: new Set(targets.map((conn) => conn.clientId)),
      params,
      resolve: resolveAnswer,
      reject: rejectAnswer,
    };
    this.#pending.set(questionId, pending);
    if (request.signal !== undefined) {
      const listener = () => {
        this.#withdraw(pending, new Error('ask_user_question aborted before frontend answered'));
      };
      pending.abort = { signal: request.signal, listener };
      request.signal.addEventListener('abort', listener, { once: true });
      // Cover an abort racing the initial `aborted` check and listener setup.
      if (request.signal.aborted) listener();
    }
    if (!this.#pending.has(questionId)) return answerPromise;
    for (const conn of targets) {
      try {
        conn.notify(Methods.QuestionRequest, params);
      } catch {
        // Best-effort fan-out; a dead target settles via disconnect().
      }
    }
    return answerPromise;
  }

  #settle(pending: PendingQuestion, answers: HostQuestionAnswers, winner?: string): void {
    if (!this.#pending.delete(pending.questionId)) return;
    this.#cleanupAbort(pending);
    const closed: QuestionClosedNotification = {
      questionId: pending.questionId,
      answers,
      ...(winner !== undefined ? { winner } : {}),
    };
    this.#notifyLosers(pending, closed, winner);
    pending.resolve(answers);
  }

  #withdraw(pending: PendingQuestion, err: Error): void {
    if (!this.#pending.delete(pending.questionId)) return;
    this.#cleanupAbort(pending);
    const closed: QuestionClosedNotification = { questionId: pending.questionId };
    this.#notifyLosers(pending, closed, undefined);
    pending.reject(err);
  }

  #cleanupAbort(pending: PendingQuestion): void {
    if (!pending.abort) return;
    pending.abort.signal.removeEventListener('abort', pending.abort.listener);
    pending.abort = undefined;
  }

  #notifyLosers(
    pending: PendingQuestion,
    closed: QuestionClosedNotification,
    winner: string | undefined,
  ): void {
    for (const clientId of pending.targets) {
      if (clientId === winner) continue;
      const conn = this.#broker.allConnections().find((c) => c.clientId === clientId);
      try {
        conn?.notify(Notifications.QuestionClosed, closed);
      } catch {
        // Best-effort.
      }
    }
  }
}
