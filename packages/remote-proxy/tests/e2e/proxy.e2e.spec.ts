/**
 * Real-stack e2e: the proxy plugin mounted on a real cordis `Context`
 * together with the REAL `DaemonRemoteSessions` provider, driven through a
 * REAL `BackendServer` (remote-backend serve logic over in-memory byte
 * pipes — the BackendRig pattern from `@dsh-remote/remote-daemon` e2e).
 * Nothing on the wire is faked; assertions go through the REAL upstream
 * service surface (`ctx.sessions`, `ctx.agents`, `ctx.sessionPersistence`,
 * the `approval/request` waterfall, the `userQuestions` provider).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { UserQuestionService } from '@deepseek-ai/dsh-user-questions';
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval';
import { DaemonRemoteSessions } from '@dsh-remote/remote-daemon';
import type { SessionEvent } from '@dsh-remote/seams';
import RemoteProxyPlugin from '../../src/index.js';
import { BackendRig, E2E_TOKEN, RigRemoteHub } from '@dsh-remote/test-fakes';

const REF = 'tok-ref';

interface Setup {
  ctx: Context;
  hub: RigRemoteHub;
  rig: BackendRig;
  dispose: () => Promise<void>;
}

/** `fill` rigs remote state BEFORE the plugins mount (initial reconcile sees it). */
async function setup(fill?: (rig: BackendRig) => void): Promise<Setup> {
  const ctx = new Context();
  const rig = new BackendRig();
  fill?.(rig);
  const hub = new RigRemoteHub(ctx);
  hub.addRig('t1', rig, REF);
  const daemonFiber = await ctx.plugin(DaemonRemoteSessions, {
    resolveToken: async (ref: string) => {
      if (ref !== REF) throw new Error(`unknown token ref: ${ref}`);
      return E2E_TOKEN;
    },
    reconnect: { initialDelayMs: 5, maxDelayMs: 20 },
  } satisfies DaemonRemoteSessions.Config);
  const proxyFiber = await ctx.plugin(RemoteProxyPlugin, { targetId: 't1' });
  return {
    ctx,
    hub,
    rig,
    dispose: async () => {
      await proxyFiber.dispose();
      await daemonFiber.dispose();
    },
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function track(s: Setup): Setup {
  cleanups.push(s.dispose);
  return s;
}

describe('e2e: remote-backed upstream seams', () => {
  it('pre-mirrors remote sessions into ctx.sessions with seq-exact history', async () => {
    const s = track(
      await setup((rig) => {
        rig.sessions.add('s1');
        rig.sessions.emit('s1', 'turn/start', { turn: 1 });
        rig.sessions.emit('s1', 'turn/end', { turn: 1, reason: { kind: 'completed' } });
      }),
    );
    await vi.waitFor(() => expect(s.ctx.sessions.get(SessionId('s1'))).toBeDefined());
    const session = s.ctx.sessions.get(SessionId('s1'))!;
    expect(session.events.map((e) => e.seq)).toEqual([0, 1]);
    expect(session.events[0]).toMatchObject({ type: 'turn/start', data: { turn: 1 } });
    expect(s.ctx.sessions.list().map((x) => x.id as unknown as string)).toContain('s1');
    // A fabricated live agent backs the mirrored session.
    expect(s.ctx.agents.get(SessionId('s1'))?.session).toBe(session);
  });

  it('agents.create → followup → session/event observed on the local bus', async () => {
    const s = track(await setup());
    const created: string[] = [];
    s.ctx.on('session/created', (session) => created.push(session.id as unknown as string));
    const events: SessionEvent[] = [];
    s.ctx.on('session/event', (_session, event) => events.push(event as SessionEvent));

    const handle = await s.ctx.agents.create({
      sessionId: SessionId('caller-id'),
      meta: { cwd: '/work' },
    });
    const id = handle.agent.id as unknown as string;
    expect(id).toBe('caller-id');
    expect(created).toContain(id);
    // Back the fresh remote session with a fake agent so prompts land.
    s.rig.agents.add(id);

    handle.agent.followup(
      createUserMessage({ content: [{ type: 'text', text: 'hello remote' }], source: { kind: 'user' } }),
    );
    // The prompt crossed the wire to the remote agent…
    await vi.waitFor(() => expect(s.rig.agents.get(id)?.prompts).toHaveLength(1));
    expect(s.rig.agents.get(id)?.prompts[0]).toMatchObject({
      content: [{ type: 'text', text: 'hello remote' }],
    });
    // …and the remote host logging it (simulated here) mirrors back locally.
    s.rig.sessions.emit(id, 'user/message', { text: 'hello remote' });
    await vi.waitFor(() => expect(events.map((e) => e.type)).toContain('user/message'));
    expect(events[0]).toMatchObject({ seq: 0, data: { text: 'hello remote' } });
    expect(handle.agent.session.events.map((e) => e.seq)).toEqual([0]);

    // The fake agent's turn events mirror too, with remote seqs intact.
    s.rig.agents.setStatus(id, 'running');
    s.rig.sessions.emit(id, 'assistant/message', {
      turn: 1,
      step: 1,
      message: { id: 'm2', role: 'assistant', content: [], source: { kind: 'model', provider: 'p', model: 'm' } },
    });
    await vi.waitFor(() => expect(handle.agent.session.events).toHaveLength(2));
    expect(handle.agent.session.events[1]).toMatchObject({ type: 'assistant/message', seq: 1 });
    await vi.waitFor(() => expect(handle.agent.status).toBe('running'));
  });

  it('approval round trip through a locally-registered waterfall answerer', async () => {
    const s = track(
      await setup((rig) => {
        rig.sessions.add('s1');
        rig.agents.add('s1');
      }),
    );
    await vi.waitFor(() => expect(s.ctx.agents.get(SessionId('s1'))).toBeDefined());

    const seen: ApprovalRequest[] = [];
    s.ctx.on('approval/request', async (req: ApprovalRequest) => {
      seen.push(req);
      return 'allowed-once' as ApprovalOutcome;
    });

    const raised = s.rig.approvalHost.raise({
      sessionId: 's1',
      kind: 'exec',
      summary: 'run it',
      detail: { command: 'ls' },
    });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]!.agent.session.id).toBe('s1');
    expect(seen[0]!.toolName).toBe('exec');
    await expect(raised).resolves.toEqual({ decision: 'approve' });
  });

  it('question round trip through a locally-registered provider', async () => {
    const s = track(
      await setup((rig) => {
        rig.sessions.add('s1');
        rig.agents.add('s1');
      }),
    );
    await vi.waitFor(() => expect(s.ctx.agents.get(SessionId('s1'))).toBeDefined());

    const service = new UserQuestionService(s.ctx);
    service.registerProvider({
      ask: async (req) => {
        expect(req.questions[0]).toMatchObject({ id: 'q1', question: 'Pick one' });
        return { answers: [{ id: 'q1', selected: ['B'] }] };
      },
    });

    const asked = s.rig.questionHost.ask({
      sessionId: 's1',
      items: [
        {
          id: 'q1',
          question: 'Pick one',
          options: [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B' },
          ],
        },
      ],
    });
    // HostQuestionAnswers is the bare answer map (Record<itemId, optionIds>).
    await expect(asked).resolves.toEqual({ q1: 'b' });
  });

  it('cold sessionPersistence.inspect reads remote history without resuming', async () => {
    const s = track(
      await setup((rig) => {
        rig.persistence.seed('cold-1', 3);
        // A real deployment wires SessionHostAccess.listCold to the
        // persistence index; the fake keeps them separate, so register both.
        rig.sessions.cold.push({ id: 'cold-1', cwd: '/work', lastSeq: 2 });
      }),
    );

    const inspection = await s.ctx.sessionPersistence.inspect(SessionId('cold-1'));
    expect(inspection.meta.id).toBe('cold-1');
    expect(inspection.events.map((e) => e.seq)).toEqual([0, 1, 2]);
    // Cold read: no attach, no agent fabrication, no local live session.
    expect(s.ctx.sessions.get(SessionId('cold-1'))).toBeUndefined();
    expect(s.ctx.agents.get(SessionId('cold-1'))).toBeUndefined();

    const listed = await s.ctx.sessionPersistence.list();
    expect(listed.map((h) => h.id as unknown as string)).toContain('cold-1');
  });
});
