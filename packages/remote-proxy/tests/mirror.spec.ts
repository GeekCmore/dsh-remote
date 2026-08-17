/**
 * Mirroring/replay: remote history is paged into a REAL upstream `Session`
 * (seq-exact, unpublished during replay), live events append in seq order and
 * publish `session/event` through the genuine store hooks, reconnects
 * continue from the seq cursor without gaps or duplicates, and a seq
 * violation freezes the mirror instead of gutting it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@deepseek-ai/dsh-session';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { SessionEvent } from '@dsh-remote/seams';
import { readRemoteHistory } from '../src/events.js';
import { setupProxy, teardownProxy, type ProxySetup } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function track(s: ProxySetup): ProxySetup {
  cleanups.push(() => teardownProxy(s));
  return s;
}

describe('session mirroring', () => {
  it('pre-mirrors a remote session: history replayed seq-exact, then live events publish', async () => {
    const s = track(await setupProxy());
    const created: Session[] = [];
    s.ctx.on('session/created', (session) => created.push(session));
    const events: SessionEvent[] = [];
    s.ctx.on('session/event', (_session, event) => events.push(event as SessionEvent));

    // Create remote state AFTER the listeners: the activation reconcile
    // (`proxy.ready`) runs before we can subscribe, so mirror on demand.
    s.broker.createSession({ cwd: '/remote/work' });
    s.broker.emit('s-1', 'turn/start', { turn: 1 });
    s.broker.emit('s-1', 'user/message', {
      id: 'm1',
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
      source: { kind: 'user' },
    });

    await s.proxy.reconcile();
    await vi.waitFor(() => expect(s.ctx.sessions.get(SessionId('s-1'))).toBeDefined());
    const session = s.ctx.sessions.get(SessionId('s-1'))!;
    expect(session.events.map((e) => e.seq)).toEqual([0, 1]);
    expect(session.events[0]).toMatchObject({ type: 'turn/start', seq: 0, data: { turn: 1 } });
    expect(session.events[1]).toMatchObject({ type: 'user/message', seq: 1 });
    // Surface synthesis: the wire carried no surfaceOp; the mirror appended
    // the message events with the default 'append' intent.
    expect(session.events[1]).toMatchObject({ surfaceOp: 'append' });
    // History replay did NOT publish session/event (unentered appends).
    expect(events).toEqual([]);
    // ...but session/created announced the mirrored session.
    expect(created.map((s) => s.id)).toContain('s-1');

    // Live events append in seq order and publish through the store hooks.
    s.broker.emit('s-1', 'assistant/message', {
      turn: 1,
      step: 1,
      message: { id: 'm2', role: 'assistant', content: [], source: { kind: 'model', provider: 'p', model: 'm' } },
    });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({ type: 'assistant/message', seq: 2 });
    expect(session.events.map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it('reconnect resumes the mirror from the seq cursor (no gaps, no duplicates)', async () => {
    const s = track(await setupProxy());
    s.broker.createSession({});
    s.broker.emit('s-1', 'turn/start', { turn: 1 });
    await s.proxy.ready;
    await s.proxy.reconcile();
    await vi.waitFor(() => expect(s.ctx.sessions.get(SessionId('s-1'))).toBeDefined());
    const session = s.ctx.sessions.get(SessionId('s-1'))!;

    const events: SessionEvent[] = [];
    s.ctx.on('session/event', (_session, event) => events.push(event as SessionEvent));
    s.broker.emit('s-1', 'turn/end', { turn: 1, reason: { kind: 'completed' } });
    await vi.waitFor(() => expect(events).toHaveLength(1));

    // Drop the channel; the event emitted while down must arrive exactly once.
    s.broker.dropConnections();
    s.broker.emit('s-1', 'turn/start', { turn: 2 });
    s.broker.emit('s-1', 'turn/end', { turn: 2, reason: { kind: 'completed' } });
    await vi.waitFor(() => expect(session.events).toHaveLength(4), { timeout: 5000 });
    expect(session.events.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('a seq violation freezes the mirror instead of corrupting the log', async () => {
    const s = track(await setupProxy());
    s.broker.createSession({});
    await s.proxy.ready;
    await s.proxy.reconcile();
    await vi.waitFor(() => expect(s.ctx.sessions.get(SessionId('s-1'))).toBeDefined());
    const session = s.ctx.sessions.get(SessionId('s-1'))!;
    const mirror = s.proxy.mirrors.get('s-1')!;

    // Forge a gap by appending a local-only event behind the mirror's back.
    session.append('todo/write', { todos: [] });
    s.broker.emit('s-1', 'turn/start', { turn: 1 });
    await vi.waitFor(() => expect(mirror.failed).toBeDefined());
    expect(mirror.failed!.message).toContain('breaks the mirror');
  });

  it('sessions.create/fork reject synchronously with remote guidance', async () => {
    const s = track(await setupProxy());
    expect(() => s.ctx.sessions.create()).toThrow(/agents\.create/);
    expect(() => s.ctx.sessions.fork('s-1' as never)).toThrow(/forkRemote/);
  });
});

describe('readRemoteHistory', () => {
  it('pages backwards until seq 0 and returns ascending order', async () => {
    const all = Array.from({ length: 7 }, (_, seq) => ({ type: 'turn/start', seq, time: seq, data: {} }));
    const fetch = async (params: { beforeSeq?: number; maxMessages?: number }) => {
      const eligible = all.filter((e) => params.beforeSeq === undefined || e.seq < params.beforeSeq);
      const max = params.maxMessages ?? 50;
      const entries = eligible.slice(-max).map((event) => ({ seq: event.seq, event }));
      return { entries, hasMore: entries.length > 0 && entries[0]!.seq > 0 };
    };
    const events = await readRemoteHistory(fetch, 0, 3);
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('rejects a non-contiguous remote log', async () => {
    const fetch = async () => ({
      entries: [{ seq: 3, event: { type: 'turn/start', seq: 3, time: 0, data: {} } }],
      hasMore: false,
    });
    await expect(readRemoteHistory(fetch)).rejects.toThrow(/not contiguous/);
  });
});
