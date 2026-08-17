import { describe, expect, it } from 'vitest';
import { Methods, type SessionCompactResult } from '@dsh-remote/core';
import {
  FakeCompaction,
  expectRemoteError,
  handshake,
  makeWorld,
} from './fakes.js';
import { tick } from '@dsh-remote/test-utils';

async function attachedWorld(options: { compaction?: FakeCompaction } = {}) {
  const world = makeWorld(options);
  world.sessions.add('s1');
  const agent = world.agents.add('s1');
  await handshake(world.client);
  await world.client.call(Methods.SessionAttach, { sessionId: 's1', mode: 'write' });
  return { world, agent };
}

describe('session.compact', () => {
  it('compacts a live idle session held by the caller', async () => {
    const compaction = new FakeCompaction();
    const { world, agent } = await attachedWorld({ compaction });
    const res = (await world.client.call(Methods.SessionCompact, {
      sessionId: 's1',
    })) as SessionCompactResult;
    expect(res.compacted).toBe(true);
    expect(compaction.calls).toHaveLength(1);
    expect(compaction.calls[0]!.agent).toBe(agent);
  });

  it('declines REMOTE_ABORTED while the agent is running', async () => {
    const compaction = new FakeCompaction();
    const { world } = await attachedWorld({ compaction });
    world.agents.setStatus('s1', 'running');
    await expectRemoteError(
      world.client.call(Methods.SessionCompact, { sessionId: 's1' }),
      'REMOTE_ABORTED',
    );
    expect(compaction.calls).toHaveLength(0);
  });

  it('declines REMOTE_ABORTED while the session waits on an approval', async () => {
    const compaction = new FakeCompaction();
    const { world } = await attachedWorld({ compaction });
    world.approvalHost.raise({ sessionId: 's1', kind: 'exec', summary: 'x' }).catch(() => {});
    await tick();
    expect((await world.broker.list())[0]!.status).toBe('waiting-approval');
    await expectRemoteError(
      world.client.call(Methods.SessionCompact, { sessionId: 's1' }),
      'REMOTE_ABORTED',
    );
    expect(compaction.calls).toHaveLength(0);
  });

  it('fails REMOTE_CAPABILITY_UNSUPPORTED without a compaction subsystem', async () => {
    const { world } = await attachedWorld();
    await expectRemoteError(
      world.client.call(Methods.SessionCompact, { sessionId: 's1' }),
      'REMOTE_CAPABILITY_UNSUPPORTED',
    );
  });

  it('requires write control', async () => {
    const compaction = new FakeCompaction();
    const world = makeWorld({ compaction });
    world.sessions.add('s1');
    world.agents.add('s1');
    await handshake(world.client);
    await world.client.call(Methods.SessionAttach, { sessionId: 's1', mode: 'read' });
    await expectRemoteError(
      world.client.call(Methods.SessionCompact, { sessionId: 's1' }),
      'REMOTE_SESSION_LOCKED',
    );
    expect(compaction.calls).toHaveLength(0);
  });
});
