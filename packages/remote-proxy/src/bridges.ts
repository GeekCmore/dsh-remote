/**
 * Approval/question bridging, remote → local → remote.
 *
 * Approvals: a remote `approval.request` (handle.onApproval, pending-replay
 * included) is surfaced to the frontend's EXISTING approval UI by dispatching
 * the LOCAL `approval/request` waterfall with an upstream-shaped
 * `ApprovalRequest` whose `agent`/`session` references are the local mirrored
 * objects (frontends route by `req.agent.session.id`; mirrored session ids
 * ARE the remote ids). The resolved outcome is forwarded via
 * `handle.answerApproval` (`'allowed-once'` → approve; everything else →
 * deny, with the local outcome recorded as the note).
 *
 * The bridge deliberately dispatches the waterfall directly instead of
 * calling the local `ApprovalService.request()`: that method appends a local
 * `approval/asked` + `approval/decided` audit pair to the session (which
 * would corrupt the mirror's seq-exactness AND duplicate the remote host's
 * own audit pair, which already arrives over the wire) and it hard-requires
 * an open local turn (which races with event delivery order, since approval
 * notifications are channel-level, not session-feed events). Fail-closed
 * semantics are preserved: no answerer / a throwing answerer / a rogue
 * outcome all normalize to `'unavailable'`, exactly like upstream `decide()`.
 * The proxy never registers as a waterfall ANSWERER — that would loop.
 *
 * Questions: same pattern through the local `ctx.userQuestions` service
 * (`UserQuestionService.ask`), so the frontend's registered provider renders
 * the prompt; the answer map is translated back to the wire shape
 * (option labels → option ids; free-text custom answers per the wire
 * contract). When no local provider/service exists the question is left
 * pending remotely (another attached client may answer) rather than answered
 * dishonestly.
 */
import type { Context, Logger } from '@deepseek-ai/cordis';
import type { Scoped } from '@deepseek-ai/dsh-scope';
import { scopeTarget } from '@deepseek-ai/dsh-scope';
import type {
  ApprovalOutcome,
  ApprovalRequest,
  ApprovalService,
} from '@deepseek-ai/dsh-user-approval';
import type {
  AskUserQuestionAnswer,
  AskUserQuestionItem,
  UserQuestionService,
} from '@deepseek-ai/dsh-user-questions';
import {
  Capabilities,
  type ApprovalRequestParams,
  type QuestionItem,
  type QuestionRequestParams,
} from '@dsh-remote/core';
import type { QuestionAnswers, RemoteClient, RemoteClientHandle } from '@dsh-remote/client';
import type { RemoteAgentFacade } from './agent.js';

const OUTCOMES: readonly ApprovalOutcome[] = ['allowed-once', 'rejected', 'cancelled', 'unavailable'];

export interface InteractionBridgesDeps {
  ctx: Context;
  client: RemoteClient;
  targetId: string;
}

export class InteractionBridges {
  private readonly ctx: Context;
  private readonly client: RemoteClient;
  private readonly targetId: string;
  private readonly logger: Logger;
  /** sessionId → unwire. */
  private readonly wired = new Map<string, () => void>();
  /** sessionId → interaction ids already surfaced locally (reconnect replay dedup). */
  private readonly surfaced = new Map<string, Set<string>>();

  constructor(deps: InteractionBridgesDeps) {
    this.ctx = deps.ctx;
    this.client = deps.client;
    this.targetId = deps.targetId;
    this.logger = deps.ctx.logger('dsh-remote/proxy');
  }

  /** Wire one mirrored session's handle to the local approval/question seams. */
  wire(handle: RemoteClientHandle, agent: RemoteAgentFacade): void {
    this.unwire(handle.sessionId);
    const unsubs: Array<() => void> = [
      handle.onApproval((req) => void this.onApproval(handle, agent, req)),
    ];
    if (this.client.capabilitiesOf(this.targetId)?.has(Capabilities.Questions)) {
      unsubs.push(handle.onQuestion((req) => void this.onQuestion(handle, agent, req)));
    }
    this.wired.set(handle.sessionId, () => {
      for (const off of unsubs) off();
    });
  }

  unwire(sessionId: string): void {
    this.wired.get(sessionId)?.();
    this.wired.delete(sessionId);
    this.surfaced.delete(sessionId);
  }

  /** True on first surfacing of an interaction id (reattach replays dedup). */
  private claim(sessionId: string, interactionId: string): boolean {
    let set = this.surfaced.get(sessionId);
    if (!set) {
      set = new Set();
      this.surfaced.set(sessionId, set);
    }
    if (set.has(interactionId)) return false;
    set.add(interactionId);
    return true;
  }

  private async onApproval(
    handle: RemoteClientHandle,
    agent: RemoteAgentFacade,
    req: ApprovalRequestParams,
  ): Promise<void> {
    if (!this.claim(req.sessionId, `approval:${req.requestId}`)) return;
    const localReq: ApprovalRequest = {
      agent,
      toolName: req.kind,
      reason:
        req.detail === undefined
          ? req.summary
          : `${req.summary}\n${safeDetail(req.detail)}`,
    };
    let outcome: ApprovalOutcome;
    try {
      // The exact dispatch of upstream `ApprovalService.decide` (scoped
      // carrier keyed by the agent, fail-closed innermost default), minus the
      // local audit appends the mirror cannot afford.
      const carrier = scopeTarget(agent, agent) as unknown as Scoped<ApprovalService>;
      const resolved = await this.ctx.waterfall(carrier, 'approval/request', localReq, () =>
        Promise.resolve('unavailable' as ApprovalOutcome),
      );
      outcome = OUTCOMES.includes(resolved as ApprovalOutcome)
        ? (resolved as ApprovalOutcome)
        : 'unavailable';
    } catch {
      outcome = 'unavailable';
    }
    const decision = outcome === 'allowed-once' ? 'approve' : 'deny';
    try {
      await handle.answerApproval(
        req.requestId,
        decision,
        outcome === 'allowed-once' || outcome === 'rejected'
          ? undefined
          : `local approval outcome: ${outcome}`,
      );
    } catch (err) {
      // Most likely settled remotely meanwhile (first answer wins); harmless.
      this.logger.warn(
        `session "${req.sessionId}": forwarding approval answer for "${req.requestId}" failed: ${String(err)}`,
      );
    }
  }

  private async onQuestion(
    handle: RemoteClientHandle,
    agent: RemoteAgentFacade,
    req: QuestionRequestParams,
  ): Promise<void> {
    if (!this.claim(req.sessionId, `question:${req.questionId}`)) return;
    const service = this.ctx.get('userQuestions') as UserQuestionService | undefined;
    if (!service) {
      this.logger.warn(
        `session "${req.sessionId}": question "${req.questionId}" left pending — no local userQuestions service`,
      );
      return;
    }
    const questions: AskUserQuestionItem[] = req.items.map((item) => ({
      id: item.id,
      question: item.question,
      ...(item.multiSelect !== undefined ? { multiSelect: item.multiSelect } : {}),
      options: item.options.map((option) => ({
        label: option.label,
        ...(option.description !== undefined ? { description: option.description } : {}),
      })),
    }));
    let answer: AskUserQuestionAnswer;
    try {
      answer = await service.ask({
        questions,
        // The service rejects owned (non-root) agents; mirrored agents are
        // registered as roots, so the facade is passed through when live.
        ...(this.ctx.agents.roots().includes(agent) ? { agent } : {}),
      });
    } catch (err) {
      // NO_PROVIDER / ASK_ABORTED / …: leave the question pending remotely
      // rather than fabricating an answer.
      this.logger.warn(
        `session "${req.sessionId}": local question ask for "${req.questionId}" failed: ${String(err)}`,
      );
      return;
    }
    try {
      await handle.answerQuestion(req.questionId, toWireAnswers(req.items, answer));
    } catch (err) {
      this.logger.warn(
        `session "${req.sessionId}": forwarding question answer for "${req.questionId}" failed: ${String(err)}`,
      );
    }
  }
}

/** Translate upstream answers (option labels + optional custom text) to the wire answer map (option ids). */
export function toWireAnswers(
  items: QuestionItem[],
  answer: AskUserQuestionAnswer,
): QuestionAnswers {
  const out: QuestionAnswers = {};
  for (const item of items) {
    const entry = answer.answers.find((a) => a.id === item.id);
    if (!entry) continue;
    const ids = entry.selected.map(
      (label) => item.options.find((option) => option.label === label)?.id ?? label,
    );
    if (item.multiSelect) {
      out[item.id] = entry.custom !== undefined ? [...ids, entry.custom] : ids;
    } else {
      out[item.id] = ids[0] ?? entry.custom ?? '';
    }
  }
  return out;
}

function safeDetail(detail: unknown): string {
  try {
    const text = JSON.stringify(detail);
    return text.length > 500 ? `${text.slice(0, 500)}…` : text;
  } catch {
    return String(detail);
  }
}
