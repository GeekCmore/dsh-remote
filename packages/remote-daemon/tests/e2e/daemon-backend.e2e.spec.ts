/**
 * End-to-end reconciliation tests: the REAL `DaemonRemoteSessions` frontend
 * stack (service → RemoteClient → TargetConnection → JsonRpcPeer →
 * handshake/reconnect) over in-memory BytePipes against a REAL
 * `BackendServer` (remote-backend serve logic with SessionBroker/
 * ApprovalBridge/MonitorCollector over in-memory host fakes). Nothing on the
 * wire is faked: real JSON-RPC framing, real HMAC pairing handshake, real
 * broker leases and replay.
 *
 * Coverage: handshake (token match/mismatch, capability recording), list →
 * read attach → live event stream (single seams-shaped envelope end to end),
 * write attach → prompt → agent events → cancel, second-client lock + force
 * preemption, drop → sinceSeq resume without gaps/dups, approval
 * request/answer round-trip through the public handle API, question wiring +
 * pendingInteractions replay (when the backend advertises the capabilities),
 * and monitor.subscribe metrics notifications.
 *
 * Protocol v2 note: the e2e backend (`@dsh-remote/backend`) is brought up to
 * v2 independently; until it advertises a capability, the client's fail-fast
 * REMOTE_CAPABILITY_UNSUPPORTED path is what this spec asserts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import {
  Capabilities,
  Methods,
  Notifications,
  type ApprovalClosedNotification,
  type ApprovalRequestParams,
  type MonitorMetricsNotification,
  type QuestionRequestParams,
} from '@dsh-remote/core';
import type { ControlChangeReason, RemoteAgentStatus } from '@dsh-remote/sessions';
import type { SessionEvent } from '@dsh-remote/seams';
import { DaemonRemoteSessions, type TargetConnection } from '../../src/index.js';
import { BackendRig, E2E_TOKEN, RigRemoteHub } from '@dsh-remote/test-fakes';

const REF = 'tok-ref';

interface Setup {
  ctx: Context;
  hub: RigRemoteHub;
  rig: BackendRig;
  sessions: DaemonRemoteSessions;
  fiber: { dispose(): Promise<void> };
}

async function setup(
  opts: {
    token?: string;
    rig?: BackendRig;
    reconnect?: { initialDelayMs?: number; maxDelayMs?: number; maxAttempts?: number };
  } = {},
): Promise<Setup> {
  const ctx = new Context();
  const rig = opts.rig ?? new BackendRig();
  const hub = new RigRemoteHub(ctx);
  hub.addRig('t1', rig, REF);
  const fiber = await ctx.plugin(DaemonRemoteSessions, {
    resolveToken: async (ref: string) => {
      if (ref !== REF) throw new Error(`unknown token ref: ${ref}`);
      return opts.token ?? E2E_TOKEN;
    },
    reconnect: { initialDelayMs: 5, maxDelayMs: 20, ...opts.reconnect },
  } satisfies DaemonRemoteSessions.Config);
  return { ctx, hub, rig, sessions: ctx.remoteSessions as DaemonRemoteSessions, fiber };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function track(setup: Setup): Setup {
  cleanups.push(() => setup.fiber.dispose());
  return setup;
}

/** The live channel of a connected service, via the PUBLIC client accessor. */
function connOf(sessions: DaemonRemoteSessions, targetId = 't1'): Promise<TargetConnection> {
  return sessions.client.connection(targetId);
}

describe('e2e handshake', () => {
  it('connects and authenticates with the matching pairing token (real HMAC)', async () => {
    const s = track(await setup());
    s.rig.sessions.add('s1');
    const list = await s.sessions.list('t1');
    expect(list).toEqual([
      {
        sessionId: 's1',
        createdAt: expect.any(Number),
        cwd: '/work',
        state: 'active',
        attached: false,
      },
    ]);
    expect(s.hub.connectCalls).toBe(1);
    // Client identity is backend-assigned: the frontend adopted the server's id.
    const conn = await connOf(s.sessions);
    expect(conn.clientId).toBe('client-1');
    // The handshake challenge's capability set was recorded (contents depend
    // on the backend revision; the recording itself is the contract).
    expect(s.sessions.client.capabilitiesOf('t1')).toBeDefined();
    expect(s.sessions.client.capabilitiesOf('t1')).toBe(conn.capabilities);
  });

  it('rejects with REMOTE_AUTH_FAILED when the token does not match', async () => {
    const s = track(await setup({ token: 'wrong-token', reconnect: { maxAttempts: 1 } }));
    await expect(s.sessions.list('t1')).rejects.toMatchObject({ code: 'REMOTE_AUTH_FAILED' });
  });
});

describe('e2e list / attach / event stream', () => {
  it('attach(read) tails from now; live events arrive verbatim in seams shape', async () => {
    const s = track(await setup());
    const session = s.rig.sessions.add('s1');
    // Emitted BEFORE the attach: a from-now attach must not replay it.
    s.rig.sessions.emit('s1', 'turn/start', { turn: 1 });

    const handle = await s.sessions.attach('t1', 's1');
    expect(handle.mode).toBe('read');
    expect(handle.lastSeq).toBe(session.seq - 1);

    const events: SessionEvent[] = [];
    handle.onEvent((e) => events.push(e));
    s.rig.sessions.emit('s1', 'output', { text: 'hello' });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    // The single wire shape end to end: seams SessionEvent verbatim, with the
    // session's own seq/time — no {kind,text} remnants, no envelope copies.
    expect(events[0]).toEqual({
      type: 'output',
      seq: 1,
      time: expect.any(Number),
      data: { text: 'hello' },
    });
    expect(handle.lastSeq).toBe(1);

    // List reflects the attach and reports the reconciled summary fields.
    const list = await s.sessions.list('t1');
    expect(list).toEqual([
      {
        sessionId: 's1',
        createdAt: session.header.createdAt,
        cwd: '/work',
        state: 'active',
        attached: true,
      },
    ]);
  });

  it('create goes through the real session.create and attaches write', async () => {
    const s = track(await setup());
    const handle = await s.sessions.create('t1', { cwd: '/build' });
    expect(handle.mode).toBe('write');
    expect(handle.sessionId).toBe('created-1');
    const list = await s.sessions.list('t1');
    expect(list).toEqual([
      {
        sessionId: 'created-1',
        createdAt: expect.any(Number),
        cwd: '/build',
        state: 'active',
        attached: true,
        controller: 'client-1',
      },
    ]);
  });
});

describe('e2e write attach / prompt / cancel', () => {
  it('prompt reaches agent.followup with a backend messageId; events and status stream back; cancel reaches the agent', async () => {
    const s = track(await setup());
    s.rig.sessions.add('s1');
    const agent = s.rig.agents.add('s1');
    const handle = await s.sessions.attach('t1', 's1', { mode: 'write' });

    const events: SessionEvent[] = [];
    const statuses: RemoteAgentStatus[] = [];
    handle.onEvent((e) => events.push(e));
    handle.onStatus((st) => statuses.push(st));

    const res = await handle.prompt('deploy it');
    // Backend-minted id (no more local- fallback): matches the followup message id.
    expect(res.messageId).toMatch(/^remote-/);
    expect(agent.prompts).toHaveLength(1);
    expect(agent.prompts[0]).toMatchObject({
      id: res.messageId,
      role: 'user',
      content: [{ type: 'text', text: 'deploy it' }],
    });

    // The fake agent starts a turn: status + an assistant event flow to the handle.
    s.rig.agents.setStatus('s1', 'running');
    s.rig.sessions.emit('s1', 'assistant/message', { text: 'on it' });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({ type: 'assistant/message', seq: 0, data: { text: 'on it' } });
    await vi.waitFor(() => expect(statuses).toEqual(['running']));
    expect(handle.status()).toBe('running');

    await handle.cancel();
    expect(agent.cancelled).toBe(1);
    s.rig.agents.setStatus('s1', 'idle');
    await vi.waitFor(() => expect(statuses).toEqual(['running', 'idle']));
  });

  it('prompt on a read-mode handle fails without write control', async () => {
    const s = track(await setup());
    s.rig.sessions.add('s1');
    const handle = await s.sessions.attach('t1', 's1');
    await expect(handle.prompt('x')).rejects.toMatchObject({ code: 'REMOTE_SESSION_LOCKED' });
  });
});

describe('e2e write-control lease across two real connections', () => {
  async function twoClients() {
    const rig = new BackendRig();
    const a = track(await setup({ rig }));
    const b = track(await setup({ rig }));
    rig.sessions.add('s1');
    rig.agents.add('s1');
    return { rig, a, b };
  }

  it('second write attach fails REMOTE_SESSION_LOCKED carrying the backend-assigned holder', async () => {
    const { a, b } = await twoClients();
    await a.sessions.attach('t1', 's1', { mode: 'write' });
    const err = await b.sessions.attach('t1', 's1', { mode: 'write' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'REMOTE_SESSION_LOCKED' });
    expect((err as { data?: { holder?: string } }).data?.holder).toBe('client-1');
  });

  it('force preempts: the old holder sees control-changed preempted and drops to read', async () => {
    const { a, b } = await twoClients();
    const ha = await a.sessions.attach('t1', 's1', { mode: 'write' });
    const controlA: Array<[string | null, ControlChangeReason]> = [];
    ha.onControlChanged((holder, reason) => controlA.push([holder, reason]));

    const hb = await b.sessions.attach('t1', 's1', { mode: 'write', force: true });
    expect(hb.mode).toBe('write');

    await vi.waitFor(() => expect(controlA).toEqual([['client-2', 'preempted']]));
    expect(ha.mode).toBe('read');
    // The preempted handle can no longer prompt (local gate), the new one can.
    await expect(ha.prompt('x')).rejects.toMatchObject({ code: 'REMOTE_SESSION_LOCKED' });
    const res = await hb.prompt('takeover');
    expect(res.messageId).toMatch(/^remote-/);
  });
});

describe('e2e reconnect / resume', () => {
  it('resumes from the seq cursor after a channel drop: no gaps, no duplicates', async () => {
    const s = track(await setup());
    s.rig.sessions.add('s1');
    s.rig.agents.add('s1');
    const handle = await s.sessions.attach('t1', 's1', { mode: 'write' });
    const events: SessionEvent[] = [];
    handle.onEvent((e) => events.push(e));

    s.rig.sessions.emit('s1', 'output', { n: 1 });
    s.rig.sessions.emit('s1', 'output', { n: 2 });
    await vi.waitFor(() => expect(events.map((e) => e.seq)).toEqual([0, 1]));

    // Network loss: the real backend process is gone, broker state survives.
    s.rig.dropConnections();
    // Emitted while the frontend is down; only replay can deliver it.
    s.rig.sessions.emit('s1', 'output', { n: 3 });
    await vi.waitFor(() => expect(s.hub.connectCalls).toBeGreaterThanOrEqual(2));
    await vi.waitFor(() => expect(events.map((e) => e.seq)).toEqual([0, 1, 2]));
    expect(events.map((e) => e.data)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(handle.lastSeq).toBe(2);

    // A fresh handshake assigned a new client id; the write lease was
    // re-acquired by the re-attach and prompting works again.
    await vi.waitFor(async () => {
      const conn = await connOf(s.sessions);
      expect(conn.connected).toBe(true);
      expect(conn.clientId).toBe('client-2');
    });
    const res = await handle.prompt('after-reconnect');
    expect(res.messageId).toMatch(/^remote-/);

    // Live delivery continues on the new channel.
    s.rig.sessions.emit('s1', 'output', { n: 4 });
    await vi.waitFor(() => expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3]));
  });
});

describe('e2e approval waterfall', () => {
  it('host approval.request reaches the write holder through handle.onApproval; handle.answerApproval resolves the waterfall', async () => {
    const s = track(await setup());
    s.rig.sessions.add('s1');
    s.rig.agents.add('s1');
    const handle = await s.sessions.attach('t1', 's1', { mode: 'write' });

    const requests: ApprovalRequestParams[] = [];
    handle.onApproval((req) => requests.push(req));

    const raised = s.rig.approvalHost.raise({
      sessionId: 's1',
      kind: 'exec',
      summary: 'rm -rf /tmp/x',
      detail: { command: 'rm -rf /tmp/x' },
    });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({
      sessionId: 's1',
      kind: 'exec',
      summary: 'rm -rf /tmp/x',
      detail: { command: 'rm -rf /tmp/x' },
    });
    // While pending, the session reports waiting-approval (mapped to running).
    await vi.waitFor(() => expect(handle.status()).toBe('running'));

    const decision = await Promise.all([
      raised,
      handle.answerApproval(requests[0]!.requestId, 'approve', 'looks safe'),
    ]).then(([d]) => d);
    expect(decision).toEqual({ decision: 'approve', note: 'looks safe' });
    // The waterfall owned the request; the host-local fallback never ran.
    expect(s.rig.approvalHost.nextCalls).toBe(0);
    await vi.waitFor(() => expect(handle.status()).toBe('idle'));
  });

  it('a second attached client is stood down via approval.closed when the holder answers', async () => {
    const rig = new BackendRig();
    const a = track(await setup({ rig }));
    const b = track(await setup({ rig }));
    rig.sessions.add('s1');
    const ha = await a.sessions.attach('t1', 's1', { mode: 'write' });
    const hb = await b.sessions.attach('t1', 's1'); // read

    const requestsA: ApprovalRequestParams[] = [];
    const requestsB: ApprovalRequestParams[] = [];
    const closedB: ApprovalClosedNotification[] = [];
    ha.onApproval((req) => requestsA.push(req));
    hb.onApproval((req) => requestsB.push(req));
    (await connOf(b.sessions)).onDaemonNotification(Notifications.ApprovalClosed, (p) =>
      closedB.push(p as ApprovalClosedNotification),
    );

    // With a write holder, ONLY the holder is asked.
    const raised = rig.approvalHost.raise({ sessionId: 's1', kind: 'exec', summary: 'x' });
    await vi.waitFor(() => expect(requestsA).toHaveLength(1));
    await Promise.all([raised, ha.answerApproval(requestsA[0]!.requestId, 'deny')]);
    expect(requestsB).toHaveLength(0);
    expect(closedB).toHaveLength(0);

    // After release, a request is broadcast; the first answer wins and the
    // other client receives approval.closed naming the winner.
    await ha.releaseControl();
    requestsA.length = 0;
    const raised2 = rig.approvalHost.raise({ sessionId: 's1', kind: 'fs-write', summary: 'y' });
    await vi.waitFor(() => expect(requestsA).toHaveLength(1));
    await vi.waitFor(() => expect(requestsB).toHaveLength(1));
    await Promise.all([raised2, ha.answerApproval(requestsA[0]!.requestId, 'approve')]);
    await vi.waitFor(() =>
      expect(closedB).toEqual([
        { requestId: requestsA[0]!.requestId, decision: 'approve', winner: 'client-1' },
      ]),
    );
    // The closed notification also cleared B's pending set: a fresh subscriber
    // sees nothing to answer.
    const late: ApprovalRequestParams[] = [];
    hb.onApproval((req) => late.push(req));
    expect(late).toEqual([]);
  });
});

describe('e2e protocol v2', () => {
  it('history / compact / fork atSeq: real round trip when advertised, fail-fast otherwise', async () => {
    const s = track(await setup());
    const session = s.rig.sessions.add('s1');
    s.rig.agents.add('s1');
    s.rig.sessions.emit('s1', 'output', { n: 1 });
    s.rig.sessions.emit('s1', 'output', { n: 2 });
    const handle = await s.sessions.attach('t1', 's1', { mode: 'write' });
    const caps = s.sessions.client.capabilitiesOf('t1')!;

    if (!caps.has(Capabilities.History)) {
      // Backend predates v2: capability-gated calls fail fast, no round trip.
      await expect(handle.history()).rejects.toMatchObject({
        code: 'REMOTE_CAPABILITY_UNSUPPORTED',
      });
      await expect(handle.compact()).rejects.toMatchObject({
        code: 'REMOTE_CAPABILITY_UNSUPPORTED',
      });
      await expect(handle.fork({ atSeq: 0 })).rejects.toMatchObject({
        code: 'REMOTE_CAPABILITY_UNSUPPORTED',
      });
      return;
    }

    const page = await handle.history({ maxMessages: 1 });
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]!.seq).toBe(1);
    expect(page.hasMore).toBe(true);
    const older = await handle.history({ beforeSeq: 1 });
    expect(older.entries.map((e) => e.seq)).toEqual([0]);
    expect(older.hasMore).toBe(false);

    await expect(handle.compact()).resolves.toEqual({ compacted: expect.any(Boolean) });

    const { sessionId: forkId } = await handle.fork({ atSeq: 0 });
    expect(forkId).not.toBe('s1');
    expect(forkId).not.toBe(session.id);
    const forkHandle = await s.sessions.attach('t1', forkId);
    expect(forkHandle.lastSeq).toBe(0);
  });

  it('structured prompt content blocks reach agent.followup when advertised', async () => {
    const s = track(await setup());
    s.rig.sessions.add('s1');
    const agent = s.rig.agents.add('s1');
    const handle = await s.sessions.attach('t1', 's1', { mode: 'write' });
    const caps = s.sessions.client.capabilitiesOf('t1')!;
    const content = [
      { type: 'text' as const, text: 'with image' },
      { type: 'image' as const, mediaType: 'image/png', data: 'aGVsbG8=' },
    ];

    if (!caps.has(Capabilities.PromptBlocks)) {
      await expect(handle.prompt({ text: 'with image', content })).rejects.toMatchObject({
        code: 'REMOTE_CAPABILITY_UNSUPPORTED',
      });
      return;
    }

    const res = await handle.prompt({ text: 'with image', content });
    expect(res.messageId).toMatch(/^remote-/);
    expect(agent.prompts[0]).toMatchObject({ id: res.messageId, role: 'user' });
    // The content blocks crossed the wire: text verbatim, image bytes saved
    // into the host attachment store and referenced by id.
    const got = agent.prompts[0]!.content as unknown[];
    expect(got).toHaveLength(2);
    expect(got[0]).toMatchObject({ type: 'text', text: 'with image' });
    expect(got[1]).toMatchObject({ type: 'image', mediaType: 'image/png', attachment: { id: 'att-1' } });
    expect(s.rig.attachments.saved).toHaveLength(1);
    expect(s.rig.attachments.saved[0]).toMatchObject({ mediaType: 'image/png' });
    expect(Buffer.from(s.rig.attachments.saved[0]!.data).toString()).toBe('hello');
  });

  it('question.request/answer round trip; pendingInteractions replay on attach', async () => {
    const s = track(await setup());
    s.rig.sessions.add('s1');
    s.rig.agents.add('s1');
    const handle = await s.sessions.attach('t1', 's1');
    const caps = s.sessions.client.capabilitiesOf('t1')!;

    if (!caps.has(Capabilities.Questions)) {
      expect(() => handle.onQuestion(() => {})).toThrowError(
        expect.objectContaining({ code: 'REMOTE_CAPABILITY_UNSUPPORTED' }),
      );
      return;
    }

    // Pending BEFORE a second client attaches: replayed via pendingInteractions
    // (requires the pending-interactions capability).
    const raised = s.rig.questionHost.ask({
      sessionId: 's1',
      summary: 'pick one',
      items: [{ id: 'choice', question: 'Pick one', options: [{ id: 'a', label: 'A' }] }],
    });
    const questions: QuestionRequestParams[] = [];
    handle.onQuestion((req) => questions.push(req));
    await vi.waitFor(() => expect(questions).toHaveLength(1));
    expect(questions[0]).toMatchObject({ sessionId: 's1', summary: 'pick one' });

    if (caps.has(Capabilities.PendingInteractions)) {
      const b = track(await setup({ rig: s.rig }));
      const hb = await b.sessions.attach('t1', 's1');
      const replayed: QuestionRequestParams[] = [];
      hb.onQuestion((req) => replayed.push(req));
      expect(replayed.map((r) => r.questionId)).toEqual([questions[0]!.questionId]);
    }

    const answers = await Promise.all([
      raised,
      handle.answerQuestion(questions[0]!.questionId, { choice: 'a' }),
    ]).then(([a]) => a);
    expect(answers).toEqual({ choice: 'a' });
  });

  it('catalog.list returns real catalogs when advertised, fail-fast otherwise', async () => {
    const s = track(await setup());
    s.rig.sessions.add('s1');
    await s.sessions.attach('t1', 's1');
    const caps = s.sessions.client.capabilitiesOf('t1')!;
    if (!caps.has(Capabilities.Catalogs)) {
      await expect(s.sessions.client.listCatalog('t1', 'models')).rejects.toMatchObject({
        code: 'REMOTE_CAPABILITY_UNSUPPORTED',
      });
      return;
    }
    const models = await s.sessions.client.listCatalog('t1', 'models');
    expect(models.kind).toBe('models');
    expect(Array.isArray(models.providers)).toBe(true);
    const skills = await s.sessions.client.listCatalog('t1', 'skills');
    expect(skills.kind).toBe('skills');
    const presets = await s.sessions.client.listCatalog('t1', 'agentPresets');
    expect(presets.kind).toBe('agentPresets');
  });
});

describe('e2e monitor', () => {
  it('monitor.subscribe pushes monitor.metrics until monitor.unsubscribe', async () => {
    const s = track(await setup());
    s.rig.sessions.add('s1');
    await s.sessions.attach('t1', 's1');
    const conn = await connOf(s.sessions);

    const samples: MonitorMetricsNotification[] = [];
    conn.onDaemonNotification(Notifications.MonitorMetrics, (p) =>
      samples.push(p as MonitorMetricsNotification),
    );
    await conn.call(Methods.MonitorSubscribe, { intervalMs: 250 });
    await vi.waitFor(() => expect(samples.length).toBeGreaterThanOrEqual(1), { timeout: 5000 });
    expect(samples[0]).toMatchObject({
      ts: expect.any(String),
      sessions: 1,
      attachedClients: 1,
      // Extended metrics fields from the (deterministic fake) sources.
      rssBytes: 12_345,
      loadAvg: [0.5, 1.0, 1.5],
      memTotalBytes: 1024 * 1024,
      memAvailableBytes: 512 * 1024,
      processCount: 3,
    });

    await conn.call(Methods.MonitorUnsubscribe);
    const count = samples.length;
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(samples.length).toBe(count);
  });
});
