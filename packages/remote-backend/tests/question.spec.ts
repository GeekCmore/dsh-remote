import { describe, expect, it } from 'vitest';
import {
  Methods,
  Notifications,
  RemoteError,
  type QuestionRequestParams,
  type SessionAttachResult,
} from '@dsh-remote/core';
import { SessionBroker } from '../src/broker.js';
import { QuestionBridge } from '../src/question.js';
import {
  FakeAgentHost,
  FakeQuestionHost,
  FakeSessionHost,
  fakeConnection,
  handshake,
  makeWorld,
} from './fakes.js';
import { tick } from './util.js';

const ITEMS = [
  {
    id: 'q1',
    question: 'Pick one',
    options: [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
    ],
  },
];

function makeBridge() {
  const sessions = new FakeSessionHost();
  const agents = new FakeAgentHost();
  const broker = new SessionBroker(sessions, agents);
  const host = new FakeQuestionHost();
  const bridge = new QuestionBridge(host, broker);
  return { sessions, broker, host, bridge };
}

describe('QuestionBridge routing', () => {
  it('routes to the write-control holder only', async () => {
    const { sessions, broker, host, bridge } = makeBridge();
    sessions.add('s1');
    const writer = fakeConnection('writer');
    const reader = fakeConnection('reader');
    broker.connect(writer.conn);
    broker.connect(reader.conn);
    broker.attach('writer', { sessionId: 's1', mode: 'write' });
    broker.attach('reader', { sessionId: 's1', mode: 'read' });

    const asked = host.ask({ sessionId: 's1', items: ITEMS });
    await tick();
    const requests = writer.notifications.filter((n) => n.method === Methods.QuestionRequest);
    expect(requests).toHaveLength(1);
    expect(reader.notifications.filter((n) => n.method === Methods.QuestionRequest)).toHaveLength(0);

    const { questionId } = requests[0]!.params as QuestionRequestParams;
    bridge.answer('writer', { questionId, answers: { q1: 'a' } });
    await expect(asked).resolves.toEqual({ q1: 'a' });
  });

  it('broadcasts to readers when no writer holds control; first answer wins', async () => {
    const { sessions, broker, host, bridge } = makeBridge();
    sessions.add('s1');
    const r1 = fakeConnection('r1');
    const r2 = fakeConnection('r2');
    broker.connect(r1.conn);
    broker.connect(r2.conn);
    broker.attach('r1', { sessionId: 's1', mode: 'read' });
    broker.attach('r2', { sessionId: 's1', mode: 'read' });

    const asked = host.ask({ sessionId: 's1', items: ITEMS });
    await tick();
    const req1 = r1.notifications.find((n) => n.method === Methods.QuestionRequest)!
      .params as QuestionRequestParams;
    const req2 = r2.notifications.find((n) => n.method === Methods.QuestionRequest)!
      .params as QuestionRequestParams;
    expect(req1.questionId).toBe(req2.questionId);

    bridge.answer('r1', { questionId: req1.questionId, answers: { q1: 'b' } });
    await expect(asked).resolves.toEqual({ q1: 'b' });
    // The loser is told to stand down.
    expect(r2.notifications).toContainEqual({
      method: Notifications.QuestionClosed,
      params: { questionId: req1.questionId, answers: { q1: 'b' }, winner: 'r1' },
    });
    // A late answer is rejected as already settled.
    expect(() => bridge.answer('r2', { questionId: req1.questionId, answers: { q1: 'a' } }))
      .toThrowError(RemoteError);
  });

  it('fails closed when nobody is attached', async () => {
    const { host } = makeBridge();
    await expect(host.ask({ sessionId: 's1', items: ITEMS })).rejects.toThrowError(
      /unavailable: no frontend attached/,
    );
  });

  it('rejects answers from non-target clients and unknown question ids', async () => {
    const { sessions, broker, host, bridge } = makeBridge();
    sessions.add('s1');
    const a = fakeConnection('a');
    const stranger = fakeConnection('stranger');
    broker.connect(a.conn);
    broker.connect(stranger.conn);
    broker.attach('a', { sessionId: 's1', mode: 'write' });

    const asked = host.ask({ sessionId: 's1', items: ITEMS });
    await tick();
    const req = a.notifications.find((n) => n.method === Methods.QuestionRequest)!
      .params as QuestionRequestParams;
    expect(() => bridge.answer('stranger', { questionId: req.questionId, answers: { q1: 'a' } }))
      .toThrowError(/not a target/);
    expect(() => bridge.answer('a', { questionId: 'qst-nope', answers: { q1: 'a' } }))
      .toThrowError(/unknown or already-settled/);
    bridge.answer('a', { questionId: req.questionId, answers: { q1: 'a' } });
    await asked;
  });

  it('settles fail-closed when the only target disconnects mid-request', async () => {
    const { sessions, broker, host, bridge } = makeBridge();
    sessions.add('s1');
    const a = fakeConnection('a');
    broker.connect(a.conn);
    broker.attach('a', { sessionId: 's1', mode: 'write' });

    const asked = host.ask({ sessionId: 's1', items: ITEMS });
    await tick();
    expect(bridge.pendingCount).toBe(1);
    bridge.disconnect('a');
    await expect(asked).rejects.toThrowError(/frontend disconnected before answering/);
    expect(bridge.pendingCount).toBe(0);
  });
});

describe('questions over the wire', () => {
  it('routes question.request to the writer and question.answer back', async () => {
    const questionHost = new FakeQuestionHost();
    const world = makeWorld({ questionHost });
    await handshake(world.client);
    world.sessions.add('s1');
    await world.client.call(Methods.SessionAttach, { sessionId: 's1', mode: 'write' });

    const requests: QuestionRequestParams[] = [];
    world.client.onNotification(Methods.QuestionRequest, (params) => {
      requests.push(params as QuestionRequestParams);
    });
    const asked = questionHost.ask({ sessionId: 's1', summary: 'need input', items: ITEMS });
    await tick();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.summary).toBe('need input');

    await world.client.call(Methods.QuestionAnswer, {
      questionId: requests[0]!.questionId,
      answers: { q1: 'a' },
    });
    await expect(asked).resolves.toEqual({ q1: 'a' });
  });

  it('replays pending interactions in the attach result', async () => {
    const questionHost = new FakeQuestionHost();
    const world = makeWorld({ questionHost });
    await handshake(world.client);
    world.sessions.add('s1');
    const first = (await world.client.call(Methods.SessionAttach, {
      sessionId: 's1',
      mode: 'write',
    })) as SessionAttachResult;
    // Nothing pending yet: the field is absent.
    expect(first.pendingInteractions).toBeUndefined();

    const asked = questionHost.ask({ sessionId: 's1', items: ITEMS });
    asked.catch(() => {});
    world.approvalHost.raise({ sessionId: 's1', kind: 'exec', summary: 'do it' }).catch(() => {});
    await tick();

    // Re-attaching replays both outstanding interactions with their stable ids.
    const again = (await world.client.call(Methods.SessionAttach, {
      sessionId: 's1',
      mode: 'read',
    })) as SessionAttachResult;
    expect(again.pendingInteractions).toHaveLength(2);
    const question = again.pendingInteractions!.find((p) => p.kind === 'question')!;
    expect(question.request.sessionId).toBe('s1');
    expect((question.request as { questionId: string }).questionId).toMatch(/^qst-/);
    const approval = again.pendingInteractions!.find((p) => p.kind === 'approval')!;
    expect((approval.request as { summary: string }).summary).toBe('do it');
    // The nested shape keeps the approval kind (e.g. "exec") intact on the wire.
    expect((approval.request as { kind: string }).kind).toBe('exec');
  });
});
