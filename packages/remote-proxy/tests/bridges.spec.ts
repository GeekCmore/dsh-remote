/**
 * Approval/question bridging: a remote request surfaces through the LOCAL
 * upstream seam (the `approval/request` waterfall / the `userQuestions`
 * provider), and the local outcome is forwarded back over the wire.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UserQuestionService, type AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions';
import type { ApprovalRequest, ApprovalOutcome } from '@deepseek-ai/dsh-user-approval';
import { Notifications, type ApprovalClosedNotification, type QuestionClosedNotification } from '@dsh-remote/core';
import { SessionId } from '@deepseek-ai/dsh-session';
import { toWireAnswers } from '../src/bridges.js';
import { FakeBackendBroker } from '@dsh-remote/test-fakes';
import { setupProxy, teardownProxy, TOKEN, type ProxySetup } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function track(s: ProxySetup): ProxySetup {
  cleanups.push(() => teardownProxy(s));
  return s;
}

async function mirrored(s: ProxySetup, sessionId = 's-1'): Promise<void> {
  s.broker.createSession({});
  await s.proxy.ready;
  await s.proxy.reconcile();
  await vi.waitFor(() => expect(s.proxy.mirrors.has(sessionId)).toBe(true));
}

describe('approval bridge', () => {
  it('remote request → local waterfall (mirrored agent/session refs) → approve forwarded', async () => {
    const s = track(await setupProxy());
    await mirrored(s);
    const closed: ApprovalClosedNotification[] = [];
    const conn = await s.client.connection('t1');
    conn.onDaemonNotification(Notifications.ApprovalClosed, (p) =>
      closed.push(p as ApprovalClosedNotification),
    );
    const seen: ApprovalRequest[] = [];
    s.ctx.on('approval/request', async (req: ApprovalRequest, _next: () => Promise<ApprovalOutcome>) => {
      seen.push(req);
      return 'allowed-once';
    });

    const requestId = s.broker.raiseApproval({ sessionId: 's-1', kind: 'exec', summary: 'run ls' });
    await vi.waitFor(() => expect(s.broker.pendingApprovalsOf('s-1')).toHaveLength(0));

    expect(seen).toHaveLength(1);
    expect(seen[0]!.toolName).toBe('exec');
    expect(seen[0]!.reason).toBe('run ls');
    // Frontends route by req.agent.session.id — the mirrored id IS the remote id.
    expect(seen[0]!.agent.session.id).toBe('s-1');
    expect(seen[0]!.agent).toBe(s.ctx.agents.get(SessionId('s-1')));
    await vi.waitFor(() => expect(closed).toHaveLength(1));
    expect(closed[0]).toMatchObject({ requestId, decision: 'approve' });
  });

  it('rejected and fail-closed outcomes forward as deny (note records the outcome)', async () => {
    const s = track(await setupProxy());
    await mirrored(s);
    const closed: ApprovalClosedNotification[] = [];
    const conn = await s.client.connection('t1');
    conn.onDaemonNotification(Notifications.ApprovalClosed, (p) =>
      closed.push(p as ApprovalClosedNotification),
    );
    s.ctx.on('approval/request', async () => 'rejected' as ApprovalOutcome);
    s.broker.raiseApproval({ sessionId: 's-1', kind: 'fs-write', summary: 'write x' });
    await vi.waitFor(() => expect(closed).toHaveLength(1));
    expect(closed[0]!.decision).toBe('deny');
  });

  it('no local answerer fails closed (unavailable → deny) without looping', async () => {
    const s = track(await setupProxy());
    await mirrored(s);
    const closed: ApprovalClosedNotification[] = [];
    const conn = await s.client.connection('t1');
    conn.onDaemonNotification(Notifications.ApprovalClosed, (p) =>
      closed.push(p as ApprovalClosedNotification),
    );
    s.broker.raiseApproval({ sessionId: 's-1', kind: 'exec', summary: 'run ls' });
    await vi.waitFor(() => expect(closed).toHaveLength(1));
    expect(closed[0]!.decision).toBe('deny');
  });

  it('a request pending at attach time is bridged (pendingInteractions replay)', async () => {
    // The approval is raised BEFORE any client attaches; the attach result's
    // pendingInteractions replay must still surface it locally.
    const broker = new FakeBackendBroker({ token: TOKEN });
    broker.createSession({});
    broker.raiseApproval({ sessionId: 's-1', kind: 'exec', summary: 'queued' });
    const s = track(await setupProxy({ broker }));
    const seen: ApprovalRequest[] = [];
    s.ctx.on('approval/request', async (req: ApprovalRequest) => {
      seen.push(req);
      return 'allowed-once' as ApprovalOutcome;
    });
    await vi.waitFor(() => expect(s.proxy.mirrors.has('s-1')).toBe(true));
    await vi.waitFor(() => expect(s.broker.pendingApprovalsOf('s-1')).toHaveLength(0));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.toolName).toBe('exec');
  });
});

describe('question bridge', () => {
  it('remote question → local provider ask → answers forwarded (labels mapped to ids)', async () => {
    const s = track(await setupProxy());
    await mirrored(s);
    const service = new UserQuestionService(s.ctx);
    const asked: AskUserQuestionRequest[] = [];
    service.registerProvider({
      ask: async (req) => {
        asked.push(req);
        return { answers: [{ id: 'q1', selected: ['Yes'] }] };
      },
    });
    const closed: QuestionClosedNotification[] = [];
    const conn = await s.client.connection('t1');
    conn.onDaemonNotification(Notifications.QuestionClosed, (p) =>
      closed.push(p as QuestionClosedNotification),
    );

    s.broker.raiseQuestion({
      sessionId: 's-1',
      items: [
        {
          id: 'q1',
          question: 'Proceed?',
          detail: 'Review the impact',
          header: 'Confirm',
          intent: { kind: 'plan-review', approve: 'Yes' },
          options: [
            { id: 'y', label: 'Yes' },
            { id: 'n', label: 'No', description: 'decline' },
          ],
        },
      ],
    });
    await vi.waitFor(() => expect(s.broker.pendingQuestionsOf('s-1')).toHaveLength(0));

    expect(asked).toHaveLength(1);
    expect(asked[0]!.questions).toEqual([
      {
        id: 'q1',
        question: 'Proceed?',
        detail: 'Review the impact',
        header: 'Confirm',
        intent: { kind: 'plan-review', approve: 'Yes' },
        options: [{ label: 'Yes' }, { label: 'No', description: 'decline' }],
      },
    ]);
    // The mirrored root agent was passed through for the liveness check.
    expect(asked[0]!.agent).toBe(s.ctx.agents.get(SessionId('s-1')));
    await vi.waitFor(() => expect(closed).toHaveLength(1));
    expect(closed[0]).toMatchObject({ answers: { q1: 'y' } });
  });

  it('without a local provider the question stays pending remotely', async () => {
    const s = track(await setupProxy());
    await mirrored(s);
    s.broker.raiseQuestion({
      sessionId: 's-1',
      items: [{ id: 'q1', question: 'Proceed?', options: [{ id: 'y', label: 'Yes' }] }],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(s.broker.pendingQuestionsOf('s-1')).toHaveLength(1);
  });
});

describe('toWireAnswers', () => {
  const items = [
    {
      id: 'single',
      question: '?',
      options: [
        { id: 'a', label: 'Alpha' },
        { id: 'b', label: 'Beta' },
      ],
    },
    {
      id: 'multi',
      question: '?',
      multiSelect: true,
      options: [
        { id: 'x', label: 'X' },
        { id: 'y', label: 'Y' },
      ],
    },
  ];

  it('maps selected labels to option ids; custom text per the wire contract', () => {
    expect(
      toWireAnswers(items, {
        answers: [
          { id: 'single', selected: ['Beta'] },
          { id: 'multi', selected: ['X', 'Y'], custom: 'both please' },
        ],
      }),
    ).toEqual({ single: 'b', multi: ['x', 'y', 'both please'] });
  });

  it('falls back to custom text when nothing was selected', () => {
    expect(toWireAnswers(items, { answers: [{ id: 'single', selected: [], custom: 'free' }] })).toEqual({
      single: 'free',
    });
  });
});
