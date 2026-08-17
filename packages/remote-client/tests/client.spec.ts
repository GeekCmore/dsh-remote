/**
 * Full-path tests of the cordis-free daemon client against the in-memory fake
 * backend: handshake/auth, capability recording + capability-absent fail-fast,
 * list mapping, read/write attach, lock + force preempt, prompt/cancel/release,
 * history/fork-atSeq/compact/prompt-blocks/catalog, approval + question wiring
 * through the public handle API, pendingInteractions replay on attach and
 * reattach, seq-cursor resume across reconnects, detach/dispose semantics.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalRequestParams, ControlChangeReason, QuestionRequestParams } from '@dsh-remote/core';
import type { SessionEvent } from '@dsh-remote/seams';
import { RemoteClient, type RemoteClientHandle } from '../src/index.js';
import type { RemoteAgentStatus } from '../src/index.js';
import { FakeBackendBroker } from './fake-backend.js';
import { FakeTargetConnector } from './fake-connector.js';
import { tick } from './byte-pipe.js';

const TOKEN = 'pairing-token';
const REF = 'tok-ref';

interface Setup {
  broker: FakeBackendBroker;
  connector: FakeTargetConnector;
  client: RemoteClient;
}

async function setup(
  opts: {
    token?: string;
    withPairingRef?: boolean;
    capabilities?: string[];
    reconnect?: { initialDelayMs?: number; maxDelayMs?: number; maxAttempts?: number };
    broker?: FakeBackendBroker;
  } = {},
): Promise<Setup> {
  const broker =
    opts.broker ??
    new FakeBackendBroker({
      token: TOKEN,
      ...(opts.capabilities !== undefined ? { capabilities: opts.capabilities } : {}),
    });
  const connector = new FakeTargetConnector();
  connector.addTarget('t1', broker, opts.withPairingRef === false ? undefined : REF);
  const client = new RemoteClient(connector, {
    resolveToken: async (ref: string) => {
      if (ref !== REF) throw new Error(`unknown token ref: ${ref}`);
      return opts.token ?? TOKEN;
    },
    reconnect: { initialDelayMs: 5, maxDelayMs: 20, ...opts.reconnect },
  });
  return { broker, connector, client };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function track(setup: Setup): Setup {
  cleanups.push(() => setup.client.dispose());
  return setup;
}

describe('handshake / auth', () => {
  it('connects, handshakes and lists sessions', async () => {
    const s = track(await setup());
    s.broker.createSession({ cwd: '/work', title: 'Build' });
    const list = await s.client.list('t1');
    expect(list).toEqual([
      {
        sessionId: 's-1',
        title: 'Build',
        createdAt: expect.any(Number),
        cwd: '/work',
        state: 'active',
        attached: false,
      },
    ]);
    expect(s.connector.connectCalls).toBe(1);
  });

  it('maps ended sessions to state cold', async () => {
    const s = track(await setup());
    const { sessionId } = s.broker.createSession({});
    s.broker.setStatus(sessionId, 'ended');
    const list = await s.client.list('t1');
    expect(list[0]).toMatchObject({ sessionId, state: 'cold', attached: false });
  });

  it('rejects with REMOTE_AUTH_FAILED when the token is wrong', async () => {
    const s = track(await setup({ token: 'wrong-token', reconnect: { maxAttempts: 1 } }));
    await expect(s.client.list('t1')).rejects.toMatchObject({ code: 'REMOTE_AUTH_FAILED' });
  });

  it('rejects with REMOTE_NOT_BOOTSTRAPPED when the target has no pairingTokenRef', async () => {
    const s = track(await setup({ withPairingRef: false, reconnect: { maxAttempts: 1 } }));
    await expect(s.client.list('t1')).rejects.toMatchObject({ code: 'REMOTE_NOT_BOOTSTRAPPED' });
  });
});

describe('capabilities', () => {
  it('records the backend-advertised capability set from the handshake challenge', async () => {
    const s = track(await setup());
    expect(s.client.capabilitiesOf('t1')).toBeUndefined(); // no channel yet
    await s.client.list('t1');
    const caps = s.client.capabilitiesOf('t1');
    expect(caps).toBeDefined();
    for (const cap of ['history', 'compact', 'fork-at-seq', 'questions', 'prompt-blocks', 'catalogs', 'pending-interactions']) {
      expect(caps!.has(cap)).toBe(true);
    }
    // The public channel accessor exposes the same recorded set.
    const conn = await s.client.connection('t1');
    expect(conn.capabilities).toBe(caps);
    expect(conn.clientId).toMatch(/^fake-client-/);
  });

  it('fails v2 features fast with REMOTE_CAPABILITY_UNSUPPORTED against a pre-v2 backend (no round trip)', async () => {
    const s = track(await setup({ capabilities: [] }));
    const { sessionId } = s.broker.createSession({});
    s.broker.emit(sessionId, 'output', { n: 1 });
    const handle = await s.client.attach('t1', sessionId, { mode: 'write' });
    expect(s.client.capabilitiesOf('t1')!.size).toBe(0);
    await expect(handle.history()).rejects.toMatchObject({ code: 'REMOTE_CAPABILITY_UNSUPPORTED' });
    await expect(handle.compact()).rejects.toMatchObject({ code: 'REMOTE_CAPABILITY_UNSUPPORTED' });
    await expect(handle.fork({ atSeq: 0 })).rejects.toMatchObject({ code: 'REMOTE_CAPABILITY_UNSUPPORTED' });
    await expect(
      handle.prompt({ text: 'hi', content: [{ type: 'text', text: 'hi' }] }),
    ).rejects.toMatchObject({ code: 'REMOTE_CAPABILITY_UNSUPPORTED' });
    expect(() => handle.onQuestion(() => {})).toThrowError(
      expect.objectContaining({ code: 'REMOTE_CAPABILITY_UNSUPPORTED' }),
    );
    await expect(
      handle.answerQuestion('q-1', { a: 'b' }),
    ).rejects.toMatchObject({ code: 'REMOTE_CAPABILITY_UNSUPPORTED' });
    await expect(s.client.listCatalog('t1', 'models')).rejects.toMatchObject({
      code: 'REMOTE_CAPABILITY_UNSUPPORTED',
    });
    // Nothing was recorded backend-side: the failures were local.
    expect(s.broker.compactCalls).toHaveLength(0);
    expect(s.broker.forkCalls).toHaveLength(0);
    // Plain prompt (no content blocks) still works against the same backend.
    const res = await handle.prompt('plain');
    expect(res.messageId).toBe('msg-1');
  });
});

describe('attach / events', () => {
  it('attaches read by default and streams events in seq order', async () => {
    const s = track(await setup());
    const { sessionId } = s.broker.createSession({});
    const handle = await s.client.attach('t1', sessionId);
    expect(handle.mode).toBe('read');
    expect(handle.lastSeq).toBe(-1);
    const events: SessionEvent[] = [];
    handle.onEvent((e) => events.push(e));
    s.broker.emit(sessionId, 'output', { text: 'a' });
    s.broker.emit(sessionId, 'output', { text: 'b' });
    await vi.waitFor(() => expect(events.map((e) => e.seq)).toEqual([0, 1]));
    expect(events[0]).toMatchObject({ type: 'output', data: { text: 'a' } });
    expect(handle.lastSeq).toBe(1);
    expect(s.broker.attachedClients(sessionId)).toBe(1);
  });

  it('attach is idempotent and escalates mode on write re-attach', async () => {
    const s = track(await setup());
    const { sessionId } = s.broker.createSession({});
    const h1 = await s.client.attach('t1', sessionId);
    const h2 = await s.client.attach('t1', sessionId);
    expect(h2).toBe(h1);
    const h3 = await s.client.attach('t1', sessionId, { mode: 'write' });
    expect(h3).toBe(h1);
    expect(h1.mode).toBe('write');
    expect(s.broker.attachedClients(sessionId)).toBe(1);
    expect(s.broker.holderOf(sessionId)).not.toBeNull();
  });

  it('create makes a remote session, attaches write and fires sessions-changed', async () => {
    const s = track(await setup());
    const changed: string[] = [];
    s.client.onSessionsChanged((targetId) => {
      changed.push(targetId);
    });
    const handle = await s.client.create('t1', { cwd: '/work', title: 'Job' });
    expect(handle.mode).toBe('write');
    expect(changed).toEqual(['t1']);
    const list = await s.client.list('t1');
    expect(list).toEqual([
      expect.objectContaining({
        sessionId: handle.sessionId,
        title: 'Job',
        cwd: '/work',
        state: 'active',
        attached: true,
        controller: expect.any(String),
      }),
    ]);
  });
});

describe('write lease', () => {
  async function twoClients() {
    const broker = new FakeBackendBroker({ token: TOKEN });
    const a = track(await setup({ broker }));
    const b = track(await setup({ broker }));
    const { sessionId } = broker.createSession({});
    return { broker, a, b, sessionId };
  }

  it('rejects a second write attach with REMOTE_SESSION_LOCKED carrying the holder', async () => {
    const { a, b, sessionId } = await twoClients();
    await a.client.attach('t1', sessionId, { mode: 'write' });
    const err = await b.client.attach('t1', sessionId, { mode: 'write' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'REMOTE_SESSION_LOCKED' });
    expect((err as { data?: { holder?: string } }).data?.holder).toEqual(expect.any(String));
  });

  it('force preempts the holder, downgrades it and maps control-changed', async () => {
    const { broker, a, b, sessionId } = await twoClients();
    const ha = await a.client.attach('t1', sessionId, { mode: 'write' });
    const controlA: Array<[string | null, ControlChangeReason]> = [];
    ha.onControlChanged((holder, reason) => controlA.push([holder, reason]));
    const hb = await b.client.attach('t1', sessionId, { mode: 'write', force: true });
    expect(hb.mode).toBe('write');
    await vi.waitFor(() => expect(controlA).toEqual([[expect.any(String), 'preempted']]));
    expect(ha.mode).toBe('read');
    expect(broker.holderOf(sessionId)).not.toBeNull();
    await expect(ha.prompt('x')).rejects.toMatchObject({ code: 'REMOTE_SESSION_LOCKED' });
  });

  it('releaseControl frees the lease and downgrades to read', async () => {
    const s = track(await setup());
    const { sessionId } = s.broker.createSession({});
    const handle = await s.client.attach('t1', sessionId, { mode: 'write' });
    const control: Array<[string | null, ControlChangeReason]> = [];
    handle.onControlChanged((holder, reason) => control.push([holder, reason]));
    await handle.releaseControl();
    expect(handle.mode).toBe('read');
    expect(s.broker.holderOf(sessionId)).toBeNull();
    await vi.waitFor(() => expect(control).toEqual([[null, 'released']]));
    await expect(handle.prompt('x')).rejects.toMatchObject({ code: 'REMOTE_SESSION_LOCKED' });
  });
});

describe('prompt / cancel / status', () => {
  it('prompts with write control, receives event + running status, cancels back to idle', async () => {
    const s = track(await setup());
    const { sessionId } = s.broker.createSession({});
    const handle = await s.client.attach('t1', sessionId, { mode: 'write' });
    const statuses: RemoteAgentStatus[] = [];
    const events: SessionEvent[] = [];
    handle.onStatus((st) => statuses.push(st));
    handle.onEvent((e) => events.push(e));
    const res = await handle.prompt('hello');
    expect(res).toEqual({ messageId: 'msg-1' });
    await vi.waitFor(() => expect(statuses).toEqual(['running']));
    expect(handle.status()).toBe('running');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'user/message', seq: 0, data: { text: 'hello' } });
    await handle.cancel();
    await vi.waitFor(() => expect(statuses).toEqual(['running', 'idle']));
    expect(handle.status()).toBe('idle');
  });

  it('prompt with content blocks sends text + structured content', async () => {
    const s = track(await setup());
    const { sessionId } = s.broker.createSession({});
    const handle = await s.client.attach('t1', sessionId, { mode: 'write' });
    const events: SessionEvent[] = [];
    handle.onEvent((e) => events.push(e));
    const content = [
      { type: 'text' as const, text: 'look at this' },
      { type: 'image' as const, mediaType: 'image/png', data: 'aGVsbG8=', name: 'shot.png' },
    ];
    const res = await handle.prompt({ text: 'look at this', content });
    expect(res.messageId).toBe('msg-1');
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({
      type: 'user/message',
      data: { text: 'look at this', content },
    });
  });

  it('rejects prompt on a read-mode handle', async () => {
    const s = track(await setup());
    const { sessionId } = s.broker.createSession({});
    const handle = await s.client.attach('t1', sessionId);
    await expect(handle.prompt('x')).rejects.toMatchObject({ code: 'REMOTE_SESSION_LOCKED' });
  });
});

describe('history / fork / compact / catalogs', () => {
  it('history pages backwards with beforeSeq/maxMessages and hasMore', async () => {
    const s = track(await setup());
    const { sessionId } = s.broker.createSession({});
    for (let n = 1; n <= 5; n++) s.broker.emit(sessionId, 'output', { n });
    const handle = await s.client.attach('t1', sessionId);
    // attach from-now does not deliver history; the cold read does.
    const events: SessionEvent[] = [];
    handle.onEvent((e) => events.push(e));
    expect(events).toHaveLength(0);

    const page1 = await handle.history({ maxMessages: 2 });
    expect(page1.entries.map((e) => e.seq)).toEqual([3, 4]);
    expect(page1.entries[0]!.event).toMatchObject({ type: 'output', data: { n: 4 } });
    expect(page1.hasMore).toBe(true);

    const page2 = await handle.history({ beforeSeq: page1.entries[0]!.seq, maxMessages: 2 });
    expect(page2.entries.map((e) => e.seq)).toEqual([1, 2]);
    expect(page2.hasMore).toBe(true);

    const page3 = await handle.history({ beforeSeq: 1, maxMessages: 2 });
    expect(page3.entries.map((e) => e.seq)).toEqual([0]);
    expect(page3.hasMore).toBe(false);
  });

  it('fork at a turn boundary truncates the fork history at atSeq', async () => {
    const s = track(await setup());
    const { sessionId } = s.broker.createSession({ title: 'Src' });
    for (let n = 1; n <= 4; n++) s.broker.emit(sessionId, 'output', { n });
    const handle = await s.client.attach('t1', sessionId);
    const { sessionId: forkId } = await handle.fork({ atSeq: 1 });
    expect(s.broker.forkCalls).toEqual([{ source: sessionId, upto: 1 }]);
    const forkHandle = await s.client.attach('t1', forkId);
    expect(forkHandle.lastSeq).toBe(1); // events 0..1 replayed boundary
    const hist = await forkHandle.history();
    expect(hist.entries.map((e) => e.seq)).toEqual([0, 1]);
  });

  it('compact compacts an idle session and declines while running', async () => {
    const s = track(await setup());
    const { sessionId } = s.broker.createSession({});
    const handle = await s.client.attach('t1', sessionId, { mode: 'write' });
    await expect(handle.compact()).resolves.toEqual({ compacted: true });
    await handle.prompt('work');
    await vi.waitFor(() => expect(handle.status()).toBe('running'));
    await expect(handle.compact()).resolves.toEqual({ compacted: false });
    expect(s.broker.compactCalls).toEqual([sessionId, sessionId]);
  });

  it('catalog.list returns the canned catalogs per kind', async () => {
    const s = track(await setup());
    const models = await s.client.listCatalog('t1', 'models');
    expect(models.kind).toBe('models');
    expect(models.providers[0]!.models.map((m) => m.id)).toEqual(['fake-model-1', 'fake-model-2']);
    const skills = await s.client.listCatalog('t1', 'skills');
    expect(skills.kind).toBe('skills');
    expect(skills.skills).toEqual([{ name: 'fake-skill', description: 'A fake skill' }]);
    const presets = await s.client.listCatalog('t1', 'agentPresets');
    expect(presets.kind).toBe('agentPresets');
    expect(presets.agentPresets).toEqual([{ id: 'fake-preset', name: 'Fake Preset', isDefault: true }]);
  });
});

describe('approval / question wiring (public handle API)', () => {
  it('onApproval fires for a live request; answerApproval settles it', async () => {
    const s = track(await setup());
    const { sessionId } = s.broker.createSession({});
    const handle = await s.client.attach('t1', sessionId);
    const requests: ApprovalRequestParams[] = [];
    handle.onApproval((req) => requests.push(req));

    const requestId = s.broker.raiseApproval({
      sessionId,
      kind: 'exec',
      summary: 'rm -rf /tmp/x',
      detail: { command: 'rm -rf /tmp/x' },
    });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({ requestId, sessionId, kind: 'exec', summary: 'rm -rf /tmp/x' });

    await handle.answerApproval(requestId, 'approve', 'looks safe');
    expect(s.broker.pendingApprovalsOf(sessionId)).toHaveLength(0);
    // Settled requests do not replay to new subscribers.
    const late: ApprovalRequestParams[] = [];
    handle.onApproval((req) => late.push(req));
    expect(late).toHaveLength(0);
  });

  it('onQuestion fires for a live request; answerQuestion settles it', async () => {
    const s = track(await setup());
    const { sessionId } = s.broker.createSession({});
    const handle = await s.client.attach('t1', sessionId);
    const questions: QuestionRequestParams[] = [];
    handle.onQuestion((req) => questions.push(req));

    const questionId = s.broker.raiseQuestion({
      sessionId,
      summary: 'Need a choice',
      items: [
        {
          id: 'flavor',
          question: 'Pick a flavor',
          options: [
            { id: 'vanilla', label: 'Vanilla' },
            { id: 'chocolate', label: 'Chocolate' },
          ],
        },
      ],
    });
    await vi.waitFor(() => expect(questions).toHaveLength(1));
    expect(questions[0]).toMatchObject({ questionId, sessionId, summary: 'Need a choice' });
    expect(questions[0]!.items[0]!.options).toHaveLength(2);

    await handle.answerQuestion(questionId, { flavor: 'vanilla' });
    expect(s.broker.pendingQuestionsOf(sessionId)).toHaveLength(0);
  });

  it('pendingInteractions raised BEFORE attach replay to a subscriber registered after attach', async () => {
    const s = track(await setup());
    const { sessionId } = s.broker.createSession({});
    const apprId = s.broker.raiseApproval({ sessionId, kind: 'exec', summary: 'pending approval' });
    const qId = s.broker.raiseQuestion({
      sessionId,
      items: [{ id: 'x', question: 'Pending?', options: [{ id: 'y', label: 'Yes' }] }],
    });
    // Attach AFTER the interactions were raised: they arrive via the attach
    // result's pendingInteractions, not via live notifications.
    const handle = await s.client.attach('t1', sessionId);
    const approvals: ApprovalRequestParams[] = [];
    const questions: QuestionRequestParams[] = [];
    handle.onApproval((req) => approvals.push(req));
    handle.onQuestion((req) => questions.push(req));
    expect(approvals.map((r) => r.requestId)).toEqual([apprId]);
    expect(questions.map((r) => r.questionId)).toEqual([qId]);
  });

  it('pendingInteractions replay again on reattach after a reconnect', async () => {
    const s = track(await setup());
    const { sessionId } = s.broker.createSession({});
    const handle = await s.client.attach('t1', sessionId);
    const apprId = s.broker.raiseApproval({ sessionId, kind: 'exec', summary: 'sticky' });
    const requests: string[] = [];
    handle.onApproval((req) => requests.push(req.requestId));
    await vi.waitFor(() => expect(requests).toEqual([apprId]));

    s.broker.dropConnections();
    await vi.waitFor(() => expect(s.connector.connectCalls).toBeGreaterThanOrEqual(2));
    // The reattach result carried the still-pending approval: replayed again.
    await vi.waitFor(() => expect(requests).toEqual([apprId, apprId]));
    // And it is still answerable on the new channel.
    await handle.answerApproval(apprId, 'deny');
    expect(s.broker.pendingApprovalsOf(sessionId)).toHaveLength(0);
  });

  it('two clients: the first answer wins, the loser stands down via approval.closed', async () => {
    const broker = new FakeBackendBroker({ token: TOKEN });
    const a = track(await setup({ broker }));
    const b = track(await setup({ broker }));
    const { sessionId } = broker.createSession({});
    const ha = await a.client.attach('t1', sessionId, { mode: 'write' });
    const hb = await b.client.attach('t1', sessionId);

    const reqA: string[] = [];
    const reqB: string[] = [];
    ha.onApproval((r) => reqA.push(r.requestId));
    hb.onApproval((r) => reqB.push(r.requestId));
    const requestId = broker.raiseApproval({ sessionId, kind: 'exec', summary: 'x' });
    await vi.waitFor(() => expect(reqA).toEqual([requestId]));
    await vi.waitFor(() => expect(reqB).toEqual([requestId]));

    await ha.answerApproval(requestId, 'approve');
    expect(broker.pendingApprovalsOf(sessionId)).toHaveLength(0);
    // The closed notification cleared the loser's pending set: a fresh
    // subscriber on B sees nothing.
    const late: string[] = [];
    hb.onApproval((r) => late.push(r.requestId));
    expect(late).toEqual([]);
    await expect(hb.answerApproval(requestId, 'deny')).rejects.toMatchObject({
      code: 'REMOTE_PROTOCOL_ERROR',
    });
  });
});

describe('reconnect / resume', () => {
  it('fails calls fast with REMOTE_CONN_LOST while the channel is down', async () => {
    const s = track(await setup({ reconnect: { initialDelayMs: 50, maxDelayMs: 100 } }));
    const { sessionId } = s.broker.createSession({});
    const handle = await s.client.attach('t1', sessionId, { mode: 'write' });
    s.broker.dropConnections();
    await vi.waitFor(async () => {
      await expect(handle.cancel()).rejects.toMatchObject({ code: 'REMOTE_CONN_LOST' });
    });
  });

  it('reconnects with backoff and resumes events from lastSeq without gaps or dups', async () => {
    const s = track(await setup());
    const { sessionId } = s.broker.createSession({});
    const handle = await s.client.attach('t1', sessionId);
    const events: number[] = [];
    handle.onEvent((e) => events.push(e.seq));
    s.broker.emit(sessionId, 'output', { n: 1 });
    s.broker.emit(sessionId, 'output', { n: 2 });
    s.broker.emit(sessionId, 'output', { n: 3 });
    await vi.waitFor(() => expect(events).toEqual([0, 1, 2]));

    s.broker.dropConnections();
    s.broker.emit(sessionId, 'output', { n: 4 });
    await vi.waitFor(() => expect(s.connector.connectCalls).toBeGreaterThanOrEqual(2));
    await vi.waitFor(() => expect(events).toEqual([0, 1, 2, 3]));
    expect(handle.lastSeq).toBe(3);

    s.broker.emit(sessionId, 'output', { n: 5 });
    await vi.waitFor(() => expect(events).toEqual([0, 1, 2, 3, 4]));
    expect(handle.status()).toBe('idle');
  });

  it('re-acquires the write lease after reconnect and prompts again', async () => {
    const s = track(await setup());
    const { sessionId } = s.broker.createSession({});
    const handle = await s.client.attach('t1', sessionId, { mode: 'write' });
    s.broker.dropConnections();
    await vi.waitFor(() => expect(s.connector.connectCalls).toBeGreaterThanOrEqual(2));
    await vi.waitFor(() => expect(s.broker.holderOf(sessionId)).not.toBeNull());
    expect(handle.mode).toBe('write');
    const res = await handle.prompt('after-reconnect');
    expect(res.messageId).toBe('msg-1');
  });

  it('status is unaffected by the reconnect window', async () => {
    const s = track(await setup({ reconnect: { initialDelayMs: 30, maxDelayMs: 60 } }));
    const { sessionId } = s.broker.createSession({});
    const handle = await s.client.attach('t1', sessionId, { mode: 'write' });
    const statuses: RemoteAgentStatus[] = [];
    handle.onStatus((st) => statuses.push(st));
    await handle.prompt('work');
    await vi.waitFor(() => expect(handle.status()).toBe('running'));
    s.broker.dropConnections();
    await tick();
    expect(handle.status()).toBe('running');
    await vi.waitFor(() => expect(s.connector.connectCalls).toBeGreaterThanOrEqual(2));
    expect(statuses).toEqual(['running']);
  });
});

describe('detach / dispose', () => {
  it('detach unsubscribes, frees the lease and is idempotent', async () => {
    const s = track(await setup());
    const { sessionId } = s.broker.createSession({});
    const handle = await s.client.attach('t1', sessionId, { mode: 'write' });
    await handle.detach();
    expect(s.broker.attachedClients(sessionId)).toBe(0);
    expect(s.broker.holderOf(sessionId)).toBeNull();
    await handle.detach();
    await expect(handle.prompt('x')).rejects.toMatchObject({ code: 'REMOTE_ABORTED' });
    const again = await s.client.attach('t1', sessionId);
    expect(again).not.toBe(handle);
  });

  it('detachAll detaches every handle of the target and fires sessions-changed', async () => {
    const s = track(await setup());
    const s1 = s.broker.createSession({});
    const s2 = s.broker.createSession({});
    const h1 = await s.client.attach('t1', s1.sessionId, { mode: 'write' });
    const h2 = await s.client.attach('t1', s2.sessionId);
    const changed: string[] = [];
    s.client.onSessionsChanged((t) => changed.push(t));
    await s.client.detachAll('t1');
    expect(changed).toEqual(['t1']);
    expect(s.broker.attachedClients(s1.sessionId)).toBe(0);
    expect(s.broker.attachedClients(s2.sessionId)).toBe(0);
    await expect(h1.cancel()).rejects.toMatchObject({ code: 'REMOTE_ABORTED' });
    await expect(h2.cancel()).rejects.toMatchObject({ code: 'REMOTE_ABORTED' });
  });

  it('dispose detaches cleanly and closes the backend channel', async () => {
    const s = track(await setup());
    const { sessionId } = s.broker.createSession({});
    const handle = await s.client.attach('t1', sessionId, { mode: 'write' });
    expect(s.broker.connectionCount()).toBe(1);
    await s.client.dispose();
    expect(s.broker.attachedClients(sessionId)).toBe(0);
    await vi.waitFor(() => expect(s.broker.connectionCount()).toBe(0));
    await expect(handle.prompt('x')).rejects.toMatchObject({ code: 'REMOTE_ABORTED' });
  });

  it('detach still completes locally when the channel is already dead', async () => {
    const s = track(await setup({ reconnect: { initialDelayMs: 60, maxDelayMs: 120 } }));
    const { sessionId } = s.broker.createSession({});
    const handle: RemoteClientHandle = await s.client.attach('t1', sessionId);
    s.broker.dropConnections();
    await tick();
    await expect(handle.detach()).resolves.toBeUndefined();
  });
});
