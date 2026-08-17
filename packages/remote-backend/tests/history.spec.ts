import { describe, expect, it } from 'vitest';
import { Methods, type SessionHistoryResult } from '@dsh-remote/core';
import { FakePersistence, expectRemoteError, handshake, makeWorld } from './fakes.js';

describe('session.history', () => {
  it('serves cold history from persistence, paginated ascending with honest hasMore', async () => {
    const persistence = new FakePersistence();
    persistence.seed('cold-1', 10);
    const world = makeWorld({ persistence });
    await handshake(world.client);

    const page1 = (await world.client.call(Methods.SessionHistory, {
      sessionId: 'cold-1',
      maxMessages: 3,
    })) as SessionHistoryResult;
    expect(page1.entries.map((e) => e.seq)).toEqual([7, 8, 9]);
    expect(page1.hasMore).toBe(true);
    expect(page1.entries[0]!.event.type).toBe('turn/start');

    const page2 = (await world.client.call(Methods.SessionHistory, {
      sessionId: 'cold-1',
      beforeSeq: 7,
      maxMessages: 3,
    })) as SessionHistoryResult;
    expect(page2.entries.map((e) => e.seq)).toEqual([4, 5, 6]);
    expect(page2.hasMore).toBe(true);

    const rest = (await world.client.call(Methods.SessionHistory, {
      sessionId: 'cold-1',
      beforeSeq: 4,
      maxMessages: 10,
    })) as SessionHistoryResult;
    expect(rest.entries.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
    expect(rest.hasMore).toBe(false);
    // Cold reads never resume an agent.
    expect(world.agents.agents.size).toBe(0);
  });

  it('serves live sessions from the in-memory log, without persistence', async () => {
    const world = makeWorld();
    world.sessions.add('s1');
    world.sessions.emit('s1', 'turn/start', { turn: 1 });
    world.sessions.emit('s1', 'todo/write', { todos: [] });
    world.sessions.emit('s1', 'turn/end', { turn: 1 });
    await handshake(world.client);

    const res = (await world.client.call(Methods.SessionHistory, {
      sessionId: 's1',
      maxMessages: 2,
    })) as SessionHistoryResult;
    expect(res.entries.map((e) => e.seq)).toEqual([1, 2]);
    expect(res.entries[1]!.event.type).toBe('turn/end');
    expect(res.hasMore).toBe(true);
  });

  it('fails REMOTE_CAPABILITY_UNSUPPORTED for cold history without persistence', async () => {
    const world = makeWorld();
    await handshake(world.client);
    await expectRemoteError(
      world.client.call(Methods.SessionHistory, { sessionId: 'gone' }),
      'REMOTE_CAPABILITY_UNSUPPORTED',
    );
  });

  it('fails REMOTE_PROTOCOL_ERROR for a session unknown to persistence', async () => {
    const world = makeWorld({ persistence: new FakePersistence() });
    await handshake(world.client);
    await expectRemoteError(
      world.client.call(Methods.SessionHistory, { sessionId: 'nope' }),
      'REMOTE_PROTOCOL_ERROR',
    );
  });
});
