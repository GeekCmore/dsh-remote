/**
 * End-to-end reconciliation tests: the REAL `DaemonRemoteSessions` frontend
 * stack (service → TargetConnection → JsonRpcPeer → handshake/reconnect) over
 * in-memory BytePipes against a REAL `BackendServer` (remote-backend serve
 * logic with SessionBroker/ApprovalBridge/MonitorCollector over in-memory
 * host fakes). Nothing on the wire is faked: real JSON-RPC framing, real
 * HMAC pairing handshake, real broker leases and replay.
 *
 * Coverage: handshake (token match/mismatch), list → read attach → live
 * event stream (single seams-shaped envelope end to end), write attach →
 * prompt → agent events → cancel, second-client lock + force preemption,
 * drop → sinceSeq resume without gaps/dups, approval request/answer
 * round-trip, and monitor.subscribe metrics notifications.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import {
  Methods,
  Notifications,
  type ApprovalClosedNotification,
  type ApprovalRequestParams,
  type MonitorMetricsNotification,
} from '@dsh-remote/core';
import type { ControlChangeReason, RemoteAgentStatus } from '@dsh-remote/sessions';
import type { SessionEvent } from '@dsh-remote/seams';
import { DaemonRemoteSessions, TargetConnection } from '../../src/index.js';
import { BackendRig, E2E_TOKEN, RigRemoteHub } from './real-backend-hub.js';

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

/** Reach the live channel of a connected service (test-only introspection). */
function connOf(sessions: DaemonRemoteSessions, targetId = 't1'): TargetConnection {
  const conns = (sessions as unknown as { conns: Map<string, TargetConnection> }).conns;
  const conn = conns.get(targetId);
  if (!conn) throw new Error('no daemon channel yet');
  return conn;
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
    expect(connOf(s.sessions).clientId).toBe('client-1');
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
    await vi.waitFor(() => {
      const conn = connOf(s.sessions);
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
  it('host approval.request reaches the write holder; the answer resolves the waterfall', async () => {
    const s = track(await setup());
    s.rig.sessions.add('s1');
    s.rig.agents.add('s1');
    const handle = await s.sessions.attach('t1', 's1', { mode: 'write' });
    const conn = connOf(s.sessions);

    const requests: ApprovalRequestParams[] = [];
    conn.onDaemonNotification(Methods.ApprovalRequest, (p) =>
      requests.push(p as ApprovalRequestParams),
    );

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
      conn.call(Methods.ApprovalAnswer, {
        requestId: requests[0]!.requestId,
        decision: 'approve',
        note: 'looks safe',
      }),
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
    await a.sessions.attach('t1', 's1', { mode: 'write' });
    await b.sessions.attach('t1', 's1'); // read
    const connA = connOf(a.sessions);
    const connB = connOf(b.sessions);

    const requestsA: ApprovalRequestParams[] = [];
    const requestsB: ApprovalRequestParams[] = [];
    const closedB: ApprovalClosedNotification[] = [];
    connA.onDaemonNotification(Methods.ApprovalRequest, (p) => requestsA.push(p as ApprovalRequestParams));
    connB.onDaemonNotification(Methods.ApprovalRequest, (p) => requestsB.push(p as ApprovalRequestParams));
    connB.onDaemonNotification(Notifications.ApprovalClosed, (p) =>
      closedB.push(p as ApprovalClosedNotification),
    );

    // With a write holder, ONLY the holder is asked.
    const raised = rig.approvalHost.raise({ sessionId: 's1', kind: 'exec', summary: 'x' });
    await vi.waitFor(() => expect(requestsA).toHaveLength(1));
    await Promise.all([
      raised,
      connA.call(Methods.ApprovalAnswer, { requestId: requestsA[0]!.requestId, decision: 'deny' }),
    ]);
    expect(requestsB).toHaveLength(0);
    expect(closedB).toHaveLength(0);

    // After release, a request is broadcast; the first answer wins and the
    // other client receives approval.closed naming the winner.
    await connA.call(Methods.SessionControlRelease, { sessionId: 's1' });
    requestsA.length = 0;
    const raised2 = rig.approvalHost.raise({ sessionId: 's1', kind: 'fs-write', summary: 'y' });
    await vi.waitFor(() => expect(requestsA).toHaveLength(1));
    await vi.waitFor(() => expect(requestsB).toHaveLength(1));
    await Promise.all([
      raised2,
      connA.call(Methods.ApprovalAnswer, { requestId: requestsA[0]!.requestId, decision: 'approve' }),
    ]);
    await vi.waitFor(() =>
      expect(closedB).toEqual([
        { requestId: requestsA[0]!.requestId, decision: 'approve', winner: 'client-1' },
      ]),
    );
  });
});

describe('e2e monitor', () => {
  it('monitor.subscribe pushes monitor.metrics until monitor.unsubscribe', async () => {
    const s = track(await setup());
    s.rig.sessions.add('s1');
    await s.sessions.attach('t1', 's1');
    const conn = connOf(s.sessions);

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
