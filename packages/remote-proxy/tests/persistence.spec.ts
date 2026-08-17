/**
 * Remote-backed `sessionPersistence`: cold reads (list/inspect/readFrom/
 * prepare/load) go through raw `session.list`/`session.history` connection
 * calls — never attaching, never resuming the remote agent — while live
 * sessions borrow the mirrored store snapshot.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionId } from '@deepseek-ai/dsh-session';
import { setupProxy, teardownProxy, type ProxySetup } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function track(s: ProxySetup): ProxySetup {
  cleanups.push(() => teardownProxy(s));
  return s;
}

describe('sessionPersistence (remote-backed)', () => {
  it('list() maps the remote catalog to headers; listSnapshots embeds lastSeq revisions', async () => {
    const s = track(await setupProxy());
    s.broker.createSession({ cwd: '/remote/work', title: 'demo' });
    s.broker.emit('s-1', 'turn/start', { turn: 1 });

    const headers = await s.ctx.sessionPersistence.list();
    expect(headers).toHaveLength(1);
    expect(headers[0]).toMatchObject({ id: 's-1', cwd: '/remote/work', version: 0 });

    const snapshots = await s.ctx.sessionPersistence.listSnapshots();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.header.id).toBe('s-1');
    expect(String(snapshots[0]!.revision)).toContain('s-1');
    expect(String(snapshots[0]!.revision)).toContain('seq0');
    // Repeated observations of an unchanged log return the same revision.
    const again = await s.ctx.sessionPersistence.listSnapshots();
    expect(again[0]!.revision).toBe(snapshots[0]!.revision);
  });

  it('cold inspect/readFrom read history without attaching or resuming', async () => {
    const s = track(await setupProxy());
    // Created after the initial reconcile: no mirror, no attach.
    await s.proxy.ready;
    expect(s.proxy.mirrors.size).toBe(0);
    s.broker.createSession({});
    s.broker.emit('s-1', 'turn/start', { turn: 1 });
    s.broker.emit('s-1', 'turn/end', { turn: 1, reason: { kind: 'completed' } });

    const inspection = await s.ctx.sessionPersistence.inspect(SessionId('s-1'));
    expect(inspection.meta.id).toBe('s-1');
    expect(inspection.events.map((e) => e.seq)).toEqual([0, 1]);
    expect(inspection.events[0]).toMatchObject({ type: 'turn/start', data: { turn: 1 } });

    const tail = await s.ctx.sessionPersistence.readFrom(SessionId('s-1'), 1);
    expect(tail.events.map((e) => e.seq)).toEqual([1]);

    // Cold reads never attached a client.
    expect(s.broker.attachedClients('s-1')).toBe(0);
    expect(s.proxy.mirrors.has('s-1')).toBe(false);
  });

  it('prepare() builds an unpublished session from a cold read (resume flow)', async () => {
    const s = track(await setupProxy());
    await s.proxy.ready;
    expect(s.proxy.mirrors.size).toBe(0);
    s.broker.createSession({});
    s.broker.emit('s-1', 'turn/start', { turn: 1 });
    s.broker.emit('s-1', 'turn/end', { turn: 1, reason: { kind: 'completed' } });

    const prep = await s.ctx.sessionPersistence.prepare(SessionId('s-1'));
    try {
      expect(prep.session.id).toBe('s-1');
      expect(prep.session.events.map((e) => e.seq)).toEqual([0, 1]);
      // Unpublished: not in the live store.
      expect(s.ctx.sessions.get(SessionId('s-1'))).toBeUndefined();
    } finally {
      prep[Symbol.dispose]();
    }
  });

  it('prepare() rejects for a live (mirrored) session', async () => {
    const s = track(await setupProxy());
    s.broker.createSession({});
    await s.proxy.ready;
    await s.proxy.reconcile();
    await vi.waitFor(() => expect(s.proxy.mirrors.has('s-1')).toBe(true));
    await expect(s.ctx.sessionPersistence.prepare(SessionId('s-1'))).rejects.toThrow(/live/);
  });

  it('live inspect borrows the mirrored snapshot; load rejects an open live turn', async () => {
    const s = track(await setupProxy());
    s.broker.createSession({});
    s.broker.emit('s-1', 'turn/start', { turn: 1 });
    await s.proxy.ready;
    await s.proxy.reconcile();
    await vi.waitFor(() => expect(s.proxy.mirrors.has('s-1')).toBe(true));

    const inspection = await s.ctx.sessionPersistence.inspect(SessionId('s-1'));
    expect(inspection.events.map((e) => e.seq)).toEqual([0]);
    await expect(s.ctx.sessionPersistence.load(SessionId('s-1'))).rejects.toThrow(/open live turn/);

    // Balanced after the turn closes.
    s.broker.emit('s-1', 'turn/end', { turn: 1, reason: { kind: 'completed' } });
    await vi.waitFor(() =>
      expect(s.ctx.sessions.get(SessionId('s-1'))!.events).toHaveLength(2),
    );
    const loaded = await s.ctx.sessionPersistence.load(SessionId('s-1'));
    expect(loaded.events.map((e) => e.seq)).toEqual([0, 1]);
  });

  it('create/append are documented no-ops; flush participates without local writes', async () => {
    const s = track(await setupProxy());
    s.broker.createSession({});
    await s.proxy.ready;
    await s.proxy.reconcile();
    await vi.waitFor(() => expect(s.proxy.mirrors.has('s-1')).toBe(true));
    const session = s.ctx.sessions.get(SessionId('s-1'))!;
    await s.ctx.sessionPersistence.create(session.header);
    await s.ctx.sessionPersistence.append(session.id, []);
    // The store's flush barrier reports participation (the remote host owns
    // actual durability — see the package README).
    await expect(s.ctx.sessions.flush(session)).resolves.toBe(true);
    expect(s.ctx.sessionPersistence.supportsRawArtifacts).toBe(false);
    expect(s.ctx.sessionPersistence.locate(session.header)).toBeUndefined();
  });
});
