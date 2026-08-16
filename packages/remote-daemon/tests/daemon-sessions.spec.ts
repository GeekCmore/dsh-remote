/**
 * Full-path tests of the daemon frontend against the in-memory fake backend:
 * handshake/auth, list mapping, read/write attach, lock + force preempt,
 * prompt/cancel/release, event ordering and seq-cursor resume across
 * reconnects, control-changed mapping, detach/dispose semantics.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import type { ControlChangeReason } from '@dsh-remote/core';
import type { RemoteAgentHandle, RemoteAgentStatus } from '@dsh-remote/sessions';
import type { SessionEvent } from '@dsh-remote/seams';
import { DaemonRemoteSessions } from '../src/index.js';
import { FakeBackendBroker } from './fake-backend.js';
import { FakeRemoteHub } from './fake-hub.js';
import { tick } from './byte-pipe.js';

const TOKEN = 'pairing-token';
const REF = 'tok-ref';

interface Setup {
  ctx: Context;
  broker: FakeBackendBroker;
  hub: FakeRemoteHub;
  sessions: DaemonRemoteSessions;
  fiber: { dispose(): Promise<void> };
}

async function setup(
  opts: {
    token?: string;
    withPairingRef?: boolean;
    reconnect?: { initialDelayMs?: number; maxDelayMs?: number; maxAttempts?: number };
    broker?: FakeBackendBroker;
  } = {},
): Promise<Setup> {
  const ctx = new Context();
  const broker = opts.broker ?? new FakeBackendBroker({ token: TOKEN });
  const hub = new FakeRemoteHub(ctx);
  hub.addBackendTarget('t1', broker, opts.withPairingRef === false ? undefined : REF);
  const fiber = await ctx.plugin(DaemonRemoteSessions, {
    resolveToken: async (ref: string) => {
      if (ref !== REF) throw new Error(`unknown token ref: ${ref}`);
      return opts.token ?? TOKEN;
    },
    reconnect: { initialDelayMs: 5, maxDelayMs: 20, ...opts.reconnect },
  } satisfies DaemonRemoteSessions.Config);
  return { ctx, broker, hub, sessions: ctx.remoteSessions as DaemonRemoteSessions, fiber };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function track(setup: Setup): Setup {
  cleanups.push(async () => {
    await setup.fiber.dispose();
  });
  return setup;
}

describe('handshake / auth', () => {
  it('connects, handshakes and lists sessions', async () => {
    const s = track(await setup());
    s.broker.createSession({ cwd: '/work', title: 'Build' });
    const list = await s.sessions.list('t1');
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
    expect(s.hub.connectCalls).toBe(1);
  });

  it('maps ended sessions to state cold', async () => {
    const s = track(await setup());
    const { sessionId } = s.broker.createSession({});
    s.broker.setStatus(sessionId, 'ended');
    const list = await s.sessions.list('t1');
    expect(list[0]).toMatchObject({ sessionId, state: 'cold', attached: false });
  });

  it('rejects with REMOTE_AUTH_FAILED when the token is wrong', async () => {
    const s = track(await setup({ token: 'wrong-token', reconnect: { maxAttempts: 1 } }));
    await expect(s.sessions.list('t1')).rejects.toMatchObject({ code: 'REMOTE_AUTH_FAILED' });
  });

  it('rejects with REMOTE_NOT_BOOTSTRAPPED when the target has no pairingTokenRef', async () => {
    const s = track(await setup({ withPairingRef: false, reconnect: { maxAttempts: 1 } }));
    await expect(s.sessions.list('t1')).rejects.toMatchObject({ code: 'REMOTE_NOT_BOOTSTRAPPED' });
  });
});

describe('attach / events', () => {
  it('attaches read by default and streams events in seq order', async () => {
    const s = track(await setup());
    const { sessionId } = s.broker.createSession({});
    const handle = await s.sessions.attach('t1', sessionId);
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
    const h1 = await s.sessions.attach('t1', sessionId);
    const h2 = await s.sessions.attach('t1', sessionId);
    expect(h2).toBe(h1);
    const h3 = await s.sessions.attach('t1', sessionId, { mode: 'write' });
    expect(h3).toBe(h1);
    expect(h1.mode).toBe('write');
    expect(s.broker.attachedClients(sessionId)).toBe(1);
    expect(s.broker.holderOf(sessionId)).not.toBeNull();
  });

  it('create makes a remote session, attaches write and emits sessions-changed', async () => {
    const s = track(await setup());
    const changed: string[] = [];
    s.ctx.on('remote/sessions-changed', (targetId) => {
      changed.push(targetId);
    });
    const handle = await s.sessions.create('t1', { cwd: '/work', title: 'Job' });
    expect(handle.mode).toBe('write');
    expect(changed).toEqual(['t1']);
    const list = await s.sessions.list('t1');
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
    await a.sessions.attach('t1', sessionId, { mode: 'write' });
    const err = await b.sessions.attach('t1', sessionId, { mode: 'write' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'REMOTE_SESSION_LOCKED' });
    expect((err as { data?: { holder?: string } }).data?.holder).toEqual(expect.any(String));
  });

  it('force preempts the holder, downgrades it and maps control-changed', async () => {
    const { broker, a, b, sessionId } = await twoClients();
    const ha = await a.sessions.attach('t1', sessionId, { mode: 'write' });
    const controlA: Array<[string | null, ControlChangeReason]> = [];
    ha.onControlChanged((holder, reason) => controlA.push([holder, reason]));
    const hb = await b.sessions.attach('t1', sessionId, { mode: 'write', force: true });
    expect(hb.mode).toBe('write');
    await vi.waitFor(() => expect(controlA).toEqual([[expect.any(String), 'preempted']]));
    expect(ha.mode).toBe('read');
    expect(broker.holderOf(sessionId)).not.toBeNull();
    // The preempted handle lost its lease locally too.
    await expect(ha.prompt('x')).rejects.toMatchObject({ code: 'REMOTE_SESSION_LOCKED' });
  });

  it('maps holder disconnect to control-changed reason disconnected', async () => {
    const { broker, a, b, sessionId } = await twoClients();
    await a.sessions.attach('t1', sessionId, { mode: 'write' });
    const hb = await b.sessions.attach('t1', sessionId);
    const controlB: Array<[string | null, ControlChangeReason]> = [];
    hb.onControlChanged((holder, reason) => controlB.push([holder, reason]));
    broker.dropFirstConnection(); // client A's channel
    // (A's daemon later reconnects and re-acquires the lease — a further
    // 'acquired' notification is expected and correct; assert the first one.)
    await vi.waitFor(() => expect(controlB.length).toBeGreaterThanOrEqual(1));
    expect(controlB[0]).toEqual([null, 'disconnected']);
  });

  it('releaseControl frees the lease and downgrades to read', async () => {
    const s = track(await setup());
    const { sessionId } = s.broker.createSession({});
    const handle = await s.sessions.attach('t1', sessionId, { mode: 'write' });
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
    const handle = await s.sessions.attach('t1', sessionId, { mode: 'write' });
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

  it('rejects prompt on a read-mode handle', async () => {
    const s = track(await setup());
    const { sessionId } = s.broker.createSession({});
    const handle = await s.sessions.attach('t1', sessionId);
    await expect(handle.prompt('x')).rejects.toMatchObject({ code: 'REMOTE_SESSION_LOCKED' });
  });
});

describe('reconnect / resume', () => {
  it('fails calls fast with REMOTE_CONN_LOST while the channel is down', async () => {
    const s = track(await setup({ reconnect: { initialDelayMs: 50, maxDelayMs: 100 } }));
    const { sessionId } = s.broker.createSession({});
    const handle = await s.sessions.attach('t1', sessionId, { mode: 'write' });
    s.broker.dropConnections();
    await vi.waitFor(async () => {
      await expect(handle.cancel()).rejects.toMatchObject({ code: 'REMOTE_CONN_LOST' });
    });
  });

  it('reconnects with backoff and resumes events from lastSeq without gaps or dups', async () => {
    const s = track(await setup());
    const { sessionId } = s.broker.createSession({});
    const handle = await s.sessions.attach('t1', sessionId);
    const events: number[] = [];
    handle.onEvent((e) => events.push(e.seq));
    s.broker.emit(sessionId, 'output', { n: 1 });
    s.broker.emit(sessionId, 'output', { n: 2 });
    s.broker.emit(sessionId, 'output', { n: 3 });
    await vi.waitFor(() => expect(events).toEqual([0, 1, 2]));

    s.broker.dropConnections();
    // Emitted while the client is down; only reachable via replay after reattach.
    s.broker.emit(sessionId, 'output', { n: 4 });
    await vi.waitFor(() => expect(s.hub.connectCalls).toBeGreaterThanOrEqual(2));
    await vi.waitFor(() => expect(events).toEqual([0, 1, 2, 3]));
    expect(handle.lastSeq).toBe(3);

    // Live delivery continues on the new channel.
    s.broker.emit(sessionId, 'output', { n: 5 });
    await vi.waitFor(() => expect(events).toEqual([0, 1, 2, 3, 4]));
    expect(handle.status()).toBe('idle');
  });

  it('re-acquires the write lease after reconnect and prompts again', async () => {
    const s = track(await setup());
    const { sessionId } = s.broker.createSession({});
    const handle = await s.sessions.attach('t1', sessionId, { mode: 'write' });
    s.broker.dropConnections();
    await vi.waitFor(() => expect(s.hub.connectCalls).toBeGreaterThanOrEqual(2));
    await vi.waitFor(() => expect(s.broker.holderOf(sessionId)).not.toBeNull());
    expect(handle.mode).toBe('write');
    const res = await handle.prompt('after-reconnect');
    expect(res.messageId).toBe('msg-1');
  });

  it('status is unaffected by the reconnect window', async () => {
    const s = track(await setup({ reconnect: { initialDelayMs: 30, maxDelayMs: 60 } }));
    const { sessionId } = s.broker.createSession({});
    const handle = await s.sessions.attach('t1', sessionId, { mode: 'write' });
    const statuses: RemoteAgentStatus[] = [];
    handle.onStatus((st) => statuses.push(st));
    await handle.prompt('work');
    await vi.waitFor(() => expect(handle.status()).toBe('running'));
    s.broker.dropConnections();
    await tick();
    expect(handle.status()).toBe('running');
    await vi.waitFor(() => expect(s.hub.connectCalls).toBeGreaterThanOrEqual(2));
    expect(statuses).toEqual(['running']);
  });
});

describe('detach / dispose', () => {
  it('detach unsubscribes, frees the lease and is idempotent', async () => {
    const s = track(await setup());
    const { sessionId } = s.broker.createSession({});
    const handle = await s.sessions.attach('t1', sessionId, { mode: 'write' });
    await handle.detach();
    expect(s.broker.attachedClients(sessionId)).toBe(0);
    expect(s.broker.holderOf(sessionId)).toBeNull();
    await handle.detach();
    await expect(handle.prompt('x')).rejects.toMatchObject({ code: 'REMOTE_ABORTED' });
    // A fresh attach after detach yields a new handle.
    const again = await s.sessions.attach('t1', sessionId);
    expect(again).not.toBe(handle);
  });

  it('detachAll detaches every handle of the target and emits sessions-changed', async () => {
    const s = track(await setup());
    const s1 = s.broker.createSession({});
    const s2 = s.broker.createSession({});
    const h1 = await s.sessions.attach('t1', s1.sessionId, { mode: 'write' });
    const h2 = await s.sessions.attach('t1', s2.sessionId);
    const changed: string[] = [];
    s.ctx.on('remote/sessions-changed', (t) => changed.push(t));
    await s.sessions.detachAll('t1');
    expect(changed).toEqual(['t1']);
    expect(s.broker.attachedClients(s1.sessionId)).toBe(0);
    expect(s.broker.attachedClients(s2.sessionId)).toBe(0);
    await expect(h1.cancel()).rejects.toMatchObject({ code: 'REMOTE_ABORTED' });
    await expect(h2.cancel()).rejects.toMatchObject({ code: 'REMOTE_ABORTED' });
  });

  it('plugin dispose detaches cleanly and closes the backend channel', async () => {
    const s = track(await setup());
    const { sessionId } = s.broker.createSession({});
    const handle = await s.sessions.attach('t1', sessionId, { mode: 'write' });
    expect(s.broker.connectionCount()).toBe(1);
    await s.fiber.dispose();
    expect(s.broker.attachedClients(sessionId)).toBe(0);
    await vi.waitFor(() => expect(s.broker.connectionCount()).toBe(0));
    await expect(handle.prompt('x')).rejects.toMatchObject({ code: 'REMOTE_ABORTED' });
  });

  it('detach still completes locally when the channel is already dead', async () => {
    const s = track(await setup({ reconnect: { initialDelayMs: 60, maxDelayMs: 120 } }));
    const { sessionId } = s.broker.createSession({});
    const handle: RemoteAgentHandle = await s.sessions.attach('t1', sessionId);
    s.broker.dropConnections();
    await tick();
    await expect(handle.detach()).resolves.toBeUndefined();
  });
});
