import { describe, expect, it } from 'vitest';
import { Methods, Notifications, RemoteError, type SessionEventEnvelope } from '@dsh-remote/core';
import { SessionBroker } from '../src/broker.js';
import {
  FakeAgentHost,
  FakeSessionHost,
  TEST_TOKEN,
  expectRemoteError,
  fakeConnection,
  handshake,
  makeWorld,
} from './fakes.js';

function makeBroker() {
  const sessions = new FakeSessionHost();
  const agents = new FakeAgentHost(sessions);
  const broker = new SessionBroker(sessions, agents);
  return { sessions, agents, broker };
}

describe('SessionBroker session.create', () => {
  it('mints session AND live agent together; the session is immediately attachable and promptable', async () => {
    const { sessions, agents, broker } = makeBroker();
    const { conn } = fakeConnection('a');
    broker.connect(conn);

    const { sessionId } = await broker.create('a', { cwd: '/build' });
    expect(sessions.get(sessionId)).toBeDefined();
    expect(sessions.get(sessionId)?.header.cwd).toBe('/build');
    expect(agents.get(sessionId)).toBeDefined();

    broker.attach('a', { sessionId, mode: 'write' });
    const { messageId } = await broker.prompt('a', sessionId, 'hello');
    expect(messageId).toMatch(/^remote-/);
    expect(agents.agents.get(sessionId)!.prompts).toHaveLength(1);
    // And the new session is listed as a live, idle session.
    const summary = (await broker.list()).find((s) => s.sessionId === sessionId)!;
    expect(summary).toMatchObject({ status: 'idle', cwd: '/build' });
  });

  it('honors a requested session id and reports conflicts explicitly', async () => {
    const { sessions, agents, broker } = makeBroker();
    const { conn } = fakeConnection('a');
    broker.connect(conn);

    await expect(
      broker.create('a', { requestedSessionId: 'caller-chosen', cwd: '/build' }),
    ).resolves.toEqual({ sessionId: 'caller-chosen' });
    expect(sessions.get('caller-chosen')).toBeDefined();
    expect(agents.get('caller-chosen')).toBeDefined();

    const err = await expectRemoteError(
      broker.create('a', { requestedSessionId: 'caller-chosen' }),
      'REMOTE_PROTOCOL_ERROR',
    );
    expect(err.data).toEqual({ requestedSessionId: 'caller-chosen' });
  });

  it('degrades to REMOTE_PROTOCOL_ERROR when the host has no agents.create', async () => {
    const sessions = new FakeSessionHost();
    const broker = new SessionBroker(sessions, { get: () => undefined });
    const { conn } = fakeConnection('a');
    broker.connect(conn);
    const err = await expectRemoteError(broker.create('a', {}), 'REMOTE_PROTOCOL_ERROR');
    expect(err.message).toContain('does not support session creation');
    expect(sessions.list()).toHaveLength(0);
  });

  it('requires a known connection', async () => {
    const { broker } = makeBroker();
    await expectRemoteError(broker.create('ghost', {}), 'REMOTE_PROTOCOL_ERROR');
  });
});

describe('SessionBroker session.list', () => {
  it('lists live and cold sessions with status/attached/controller', async () => {
    const { sessions, agents, broker } = makeBroker();
    sessions.add('s1');
    sessions.add('s2');
    agents.add('s2').status = 'running';
    sessions.cold = [{ id: 'cold-1', cwd: '/old', lastSeq: 41 }, { id: 's1' }];
    const a = fakeConnection('a');
    broker.connect(a.conn);
    broker.attach('a', { sessionId: 's1', mode: 'write' });

    const list = await broker.list();
    const s1 = list.find((s) => s.sessionId === 's1')!;
    expect(s1).toMatchObject({ status: 'idle', attachedClients: 1, controller: 'a', lastSeq: -1 });
    expect(list.find((s) => s.sessionId === 's2')!.status).toBe('running');
    const cold = list.find((s) => s.sessionId === 'cold-1')!;
    expect(cold).toMatchObject({ status: 'ended', attachedClients: 0, controller: null, lastSeq: 41 });
    // A cold id shadowed by a live session is not duplicated.
    expect(list.filter((s) => s.sessionId === 's1')).toHaveLength(1);
  });
});

describe('SessionBroker attach: replay and live feed', () => {
  it('replays persisted events after sinceSeq, then streams live', () => {
    const { sessions, broker } = makeBroker();
    sessions.add('s1');
    sessions.emit('s1', 'turn/start', { turn: 1 });
    sessions.emit('s1', 'todo/write', { todos: [] });
    sessions.emit('s1', 'turn/end', { turn: 1, reason: { kind: 'completed' } });
    const { conn, notifications } = fakeConnection('a');
    broker.connect(conn);

    const result = broker.attach('a', { sessionId: 's1', mode: 'read', sinceSeq: 0 });
    expect(result.lastSeq).toBe(2);
    const replayed = notifications
      .filter((n) => n.method === Notifications.SessionEvent)
      .map((n) => (n.params as SessionEventEnvelope).event.seq);
    expect(replayed).toEqual([1, 2]);

    sessions.emit('s1', 'turn/start', { turn: 2 });
    const live = notifications
      .filter((n) => n.method === Notifications.SessionEvent)
      .map((n) => (n.params as SessionEventEnvelope).event.seq);
    expect(live).toEqual([1, 2, 3]);
    const envelope = notifications.at(-1)!.params as SessionEventEnvelope;
    expect(envelope.sessionId).toBe('s1');
    expect(envelope.event.type).toBe('turn/start');
    expect(envelope.event.time).toEqual(expect.any(Number));
  });

  it('omits replay when sinceSeq is absent ("from now")', () => {
    const { sessions, broker } = makeBroker();
    sessions.add('s1');
    sessions.emit('s1', 'turn/start', { turn: 1 });
    const { conn, notifications } = fakeConnection('a');
    broker.connect(conn);
    broker.attach('a', { sessionId: 's1', mode: 'read' });
    expect(notifications).toHaveLength(0);
    sessions.emit('s1', 'todo/write', { todos: [] });
    expect(notifications.map((n) => (n.params as SessionEventEnvelope).event.seq)).toEqual([1]);
  });

  it('does not forward events of other sessions', () => {
    const { sessions, broker } = makeBroker();
    sessions.add('s1');
    sessions.add('s2');
    const { conn, notifications } = fakeConnection('a');
    broker.connect(conn);
    broker.attach('a', { sessionId: 's1', mode: 'read' });
    sessions.emit('s2', 'turn/start', { turn: 1 });
    expect(notifications).toHaveLength(0);
  });

  it('rejects attach to an unknown session', () => {
    const { broker } = makeBroker();
    const { conn } = fakeConnection('a');
    broker.connect(conn);
    expect(() => broker.attach('a', { sessionId: 'nope', mode: 'read' })).toThrowError(RemoteError);
  });
});

describe('SessionBroker control lease', () => {
  it('grants write attach when free and broadcasts acquired', () => {
    const { sessions, broker } = makeBroker();
    sessions.add('s1');
    const a = fakeConnection('a');
    broker.connect(a.conn);
    const result = broker.attach('a', { sessionId: 's1', mode: 'write' });
    expect(result.holder).toBe('a');
    expect(a.notifications).toContainEqual({
      method: Notifications.SessionControlChanged,
      params: { sessionId: 's1', holder: 'a', reason: 'acquired' },
    });
  });

  it('locks a second writer out with REMOTE_SESSION_LOCKED details', () => {
    const { sessions, broker } = makeBroker();
    sessions.add('s1');
    const a = fakeConnection('a');
    const b = fakeConnection('b');
    broker.connect(a.conn);
    broker.connect(b.conn);
    broker.attach('a', { sessionId: 's1', mode: 'write' });
    try {
      broker.attach('b', { sessionId: 's1', mode: 'write' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(RemoteError);
      const re = err as RemoteError;
      expect(re.code).toBe('REMOTE_SESSION_LOCKED');
      expect(re.data).toMatchObject({ holder: 'a' });
      expect((re.data as { attachedAt?: string }).attachedAt).toBeTruthy();
    }
    // b can still attach read-only.
    const result = broker.attach('b', { sessionId: 's1', mode: 'read' });
    expect(result.holder).toBe('a');
  });

  it('force preempts the holder; the loser stays attached and is notified', async () => {
    const { sessions, broker } = makeBroker();
    sessions.add('s1');
    const a = fakeConnection('a');
    const b = fakeConnection('b');
    broker.connect(a.conn);
    broker.connect(b.conn);
    broker.attach('a', { sessionId: 's1', mode: 'write' });
    const result = broker.attach('b', { sessionId: 's1', mode: 'write', force: true });
    expect(result.holder).toBe('b');
    for (const side of [a, b]) {
      expect(side.notifications).toContainEqual({
        method: Notifications.SessionControlChanged,
        params: { sessionId: 's1', holder: 'b', reason: 'preempted' },
      });
    }
    // The preempted client lost write power but keeps the event feed.
    await expect(broker.prompt('a', 's1', 'hi')).rejects.toThrowError(/controlled by/);
    sessions.emit('s1', 'todo/write', { todos: [] });
    expect(a.notifications.some((n) => n.method === Notifications.SessionEvent)).toBe(true);
  });

  it('control-release demotes the holder and broadcasts released', async () => {
    const { sessions, broker } = makeBroker();
    sessions.add('s1');
    const a = fakeConnection('a');
    broker.connect(a.conn);
    broker.attach('a', { sessionId: 's1', mode: 'write' });
    broker.controlRelease('a', 's1');
    expect(a.notifications).toContainEqual({
      method: Notifications.SessionControlChanged,
      params: { sessionId: 's1', holder: null, reason: 'released' },
    });
    await expect(broker.prompt('a', 's1', 'hi')).rejects.toThrowError(RemoteError);
    // Release by a non-holder is a no-op.
    broker.controlRelease('a', 's1');
  });

  it('detach by the holder releases the lease', () => {
    const { sessions, broker } = makeBroker();
    sessions.add('s1');
    const a = fakeConnection('a');
    broker.connect(a.conn);
    broker.attach('a', { sessionId: 's1', mode: 'write' });
    broker.detach('a', 's1');
    expect(a.notifications).toContainEqual({
      method: Notifications.SessionControlChanged,
      params: { sessionId: 's1', holder: null, reason: 'released' },
    });
  });

  it('disconnect drops subscriptions and releases leases as disconnected', () => {
    const { sessions, broker } = makeBroker();
    sessions.add('s1');
    const a = fakeConnection('a');
    const b = fakeConnection('b');
    broker.connect(a.conn);
    broker.connect(b.conn);
    broker.attach('a', { sessionId: 's1', mode: 'write' });
    broker.attach('b', { sessionId: 's1', mode: 'read' });
    broker.disconnect('a');
    expect(b.notifications).toContainEqual({
      method: Notifications.SessionControlChanged,
      params: { sessionId: 's1', holder: null, reason: 'disconnected' },
    });
    sessions.emit('s1', 'todo/write', { todos: [] });
    expect(a.notifications.filter((n) => n.method === Notifications.SessionEvent)).toHaveLength(0);
    expect(b.notifications.filter((n) => n.method === Notifications.SessionEvent)).toHaveLength(1);
  });
});

describe('SessionBroker prompt/cancel/fork gating', () => {
  it('prompt requires the write lease and reaches agent.followup', async () => {
    const { sessions, agents, broker } = makeBroker();
    sessions.add('s1');
    const agent = agents.add('s1');
    const a = fakeConnection('a');
    const b = fakeConnection('b');
    broker.connect(a.conn);
    broker.connect(b.conn);
    broker.attach('a', { sessionId: 's1', mode: 'write' });
    broker.attach('b', { sessionId: 's1', mode: 'read' });

    await expect(broker.prompt('b', 's1', 'hello')).rejects.toThrowError(/controlled by "a"|controlled by a/);
    await broker.prompt('a', 's1', 'hello');
    expect(agent.prompts).toHaveLength(1);
    expect(agent.prompts[0]).toMatchObject({ role: 'user', content: [{ type: 'text', text: 'hello' }] });
  });

  it('cancel requires the write lease and reaches agent.cancel', () => {
    const { sessions, agents, broker } = makeBroker();
    sessions.add('s1');
    const agent = agents.add('s1');
    const a = fakeConnection('a');
    broker.connect(a.conn);
    broker.attach('a', { sessionId: 's1', mode: 'write' });
    broker.cancel('a', 's1');
    expect(agent.cancelled).toBe(1);
  });

  it('prompt/cancel on a session without a live agent fail clearly', async () => {
    const { sessions, broker } = makeBroker();
    sessions.add('s1');
    const a = fakeConnection('a');
    broker.connect(a.conn);
    broker.attach('a', { sessionId: 's1', mode: 'write' });
    await expect(broker.prompt('a', 's1', 'x')).rejects.toThrowError(/no live agent/);
    expect(() => broker.cancel('a', 's1')).toThrowError(/no live agent/);
  });

  it('fork requires the write lease and returns the child id', () => {
    const { sessions, broker } = makeBroker();
    sessions.add('s1');
    sessions.emit('s1', 'turn/start', { turn: 1 });
    sessions.emit('s1', 'turn/end', { turn: 1, reason: { kind: 'completed' } });
    const a = fakeConnection('a');
    const b = fakeConnection('b');
    broker.connect(a.conn);
    broker.connect(b.conn);
    broker.attach('a', { sessionId: 's1', mode: 'write' });
    broker.attach('b', { sessionId: 's1', mode: 'read' });

    expect(() => broker.fork('b', 's1')).toThrowError(RemoteError);
    const result = broker.fork('a', 's1', 0);
    expect(result.sessionId).toContain('s1-fork');
    expect(sessions.get(result.sessionId)?.events).toHaveLength(1);
  });

  it('fork with atSeq rewinds to the given seq when boundary is absent', () => {
    const { sessions, broker } = makeBroker();
    sessions.add('s1');
    sessions.emit('s1', 'turn/start', { turn: 1 });
    sessions.emit('s1', 'turn/end', { turn: 1, reason: { kind: 'completed' } });
    sessions.emit('s1', 'turn/start', { turn: 2 });
    const a = fakeConnection('a');
    broker.connect(a.conn);
    broker.attach('a', { sessionId: 's1', mode: 'write' });

    const result = broker.fork('a', 's1', undefined, 0);
    // History up to and including seq 0 is kept; everything after is dropped.
    expect(sessions.get(result.sessionId)?.events).toHaveLength(1);
    // boundary still wins when both are passed.
    const both = broker.fork('a', 's1', 1, 0);
    expect(sessions.get(both.sessionId)?.events).toHaveLength(2);
  });
});

describe('SessionBroker status wiring', () => {
  it('forwards agent status transitions to attached clients', () => {
    const { sessions, agents, broker } = makeBroker();
    sessions.add('s1');
    agents.add('s1');
    const a = fakeConnection('a');
    broker.connect(a.conn);
    broker.attach('a', { sessionId: 's1', mode: 'read' });
    agents.setStatus('s1', 'running');
    expect(a.notifications).toContainEqual({
      method: Notifications.SessionStatus,
      params: { sessionId: 's1', status: 'running' },
    });
  });

  it('reports session disposal as ended', () => {
    const { sessions, broker } = makeBroker();
    sessions.add('s1');
    const a = fakeConnection('a');
    broker.connect(a.conn);
    broker.attach('a', { sessionId: 's1', mode: 'read' });
    sessions.disposeSession('s1');
    expect(a.notifications).toContainEqual({
      method: Notifications.SessionStatus,
      params: { sessionId: 's1', status: 'ended' },
    });
  });
});

describe('broker over the wire', () => {
  it('serves list/attach/prompt through the real JSON-RPC server', async () => {
    const world = makeWorld();
    await handshake(world.client, TEST_TOKEN);
    world.sessions.add('s1');
    const agent = world.agents.add('s1');
    world.sessions.emit('s1', 'turn/start', { turn: 1 });

    const list = (await world.client.call(Methods.SessionList)) as { sessions: unknown[] };
    expect(list.sessions).toHaveLength(1);

    const attach = (await world.client.call(Methods.SessionAttach, {
      sessionId: 's1',
      mode: 'write',
    })) as { holder: string };
    expect(attach.holder).toBe('client-1');

    await world.client.call(Methods.SessionPrompt, { sessionId: 's1', text: 'hi there' });
    expect(agent.prompts[0]?.content).toEqual([{ type: 'text', text: 'hi there' }]);

    // Locked-session error surfaces over the wire with the stable code.
    world.broker.attach; // (lease held by client-1)
    const other = fakeConnection('other');
    world.broker.connect(other.conn);
    await expectRemoteError(
      Promise.resolve().then(() => world.broker.attach('other', { sessionId: 's1', mode: 'write' })),
      'REMOTE_SESSION_LOCKED',
    );
  });

  it('session.create over the wire mints a promptable session (live agent included)', async () => {
    const world = makeWorld();
    await handshake(world.client, TEST_TOKEN);

    const created = (await world.client.call(Methods.SessionCreate, { cwd: '/build' })) as {
      sessionId: string;
    };
    expect(world.sessions.get(created.sessionId)).toBeDefined();
    expect(world.agents.get(created.sessionId)).toBeDefined();

    await world.client.call(Methods.SessionAttach, { sessionId: created.sessionId, mode: 'write' });
    await world.client.call(Methods.SessionPrompt, { sessionId: created.sessionId, text: 'hi' });
    expect(world.agents.agents.get(created.sessionId)!.prompts).toHaveLength(1);
  });
});
