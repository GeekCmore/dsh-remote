/**
 * Fabricated-agent routing: `ctx.agents.create/resume` (real upstream
 * registry + our factory) produce remote-backed agents; the facade's
 * mutating methods route to the daemon client handle, status mirrors the
 * remote lifecycle, and `dispose()` releases the remote lease and unwinds
 * the local seams.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { SessionEvent } from '@dsh-remote/seams';
import { setupProxy, teardownProxy, type ProxySetup } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function track(s: ProxySetup): ProxySetup {
  cleanups.push(() => teardownProxy(s));
  return s;
}

function userMsg(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
}

describe('agents.create', () => {
  it('creates the REMOTE session first, then mirrors it (agent id = remote id)', async () => {
    const s = track(await setupProxy());
    const created: Agent[] = [];
    s.ctx.on('agent/created', ({ agent }) => created.push(agent));
    const started: { agent: Agent; source: string }[] = [];
    s.ctx.on('agent/session-start', (payload) =>
      started.push({ agent: payload.agent, source: payload.source }),
    );

    const handle = await s.ctx.agents.create({
      sessionId: SessionId('caller-chosen'),
      meta: { cwd: '/remote/work' },
      agentOptions: { provider: 'p', model: 'm' },
    });

    expect(handle.agent.id).toBe('caller-chosen');
    expect(s.broker.holderOf('caller-chosen')).not.toBeNull(); // write lease taken
    expect(handle.agent.options).toEqual({ provider: 'p', model: 'm' });
    expect(handle.agent.status).toBe('idle');
    expect(handle.agent.session.id).toBe('caller-chosen');
    expect(handle.agent.session.events).toEqual([]);
    expect(handle.agent.inbox.hasPending).toBe(false);
    expect(s.ctx.sessions.get(SessionId('caller-chosen'))).toBe(handle.agent.session);
    expect(s.ctx.agents.get(SessionId('caller-chosen'))).toBe(handle.agent);
    expect(created).toContain(handle.agent);
    expect(started).toEqual([{ agent: handle.agent, source: 'startup' }]);
    // The scoped agent context carries the association.
    expect(handle.agent.ctx.agent).toBe(handle.agent);
  });

  it('agents.create({ seed }) rejects with remote-fork guidance', async () => {
    const s = track(await setupProxy());
    await expect(
      s.ctx.agents.create({ sessionId: SessionId('x'), seed: [] }),
    ).rejects.toThrow(/forkRemote/);
  });

  it('facade methods route to the remote handle: followup prompts, cancel cancels, status mirrors', async () => {
    const s = track(await setupProxy());
    const { agent } = await s.ctx.agents.create({ sessionId: SessionId('x') });
    const events: SessionEvent[] = [];
    s.ctx.on('session/event', (_session, event) => events.push(event as SessionEvent));
    const statuses: { status: string }[] = [];
    s.ctx.on('agent/status', (payload) => statuses.push({ status: payload.status }));

    agent.followup(userMsg('deploy it'));
    // The prompt rode the wire: the broker appended user/message and flipped
    // to running; the mirror published both locally.
    await vi.waitFor(() => expect(events.map((e) => e.type)).toContain('user/message'));
    expect(events[0]).toMatchObject({ seq: 0, data: { text: 'deploy it' } });
    await vi.waitFor(() => expect(agent.status).toBe('running'));
    expect(statuses).toEqual([{ status: 'running' }]);

    // whenIdle follows the remote status back to idle.
    const idle = agent.whenIdle();
    let idleResolved = false;
    void idle.then(() => {
      idleResolved = true;
    });
    agent.cancel({ kind: 'user' });
    await vi.waitFor(() => expect(agent.status).toBe('idle'));
    await vi.waitFor(() => expect(idleResolved).toBe(true));

    // cancel reached the remote session (broker flips running → idle).
    expect(s.broker.statusOf(agent.id as unknown as string)).toBe('idle');
  });

  it('dispose() releases the remote lease and unwinds agent + session locally', async () => {
    const s = track(await setupProxy());
    const disposedAgents: string[] = [];
    s.ctx.on('agent/disposed', ({ agent }) => disposedAgents.push(agent.id as unknown as string));
    const disposedSessions: string[] = [];
    s.ctx.on('session/disposed', (session) => disposedSessions.push(session.id as unknown as string));

    const handle = await s.ctx.agents.create({ sessionId: SessionId('x') });
    const id = handle.agent.id as unknown as string;
    await handle.dispose();

    expect(s.broker.holderOf(id)).toBeNull(); // lease released
    expect(s.broker.attachedClients(id)).toBe(0); // attachment dropped
    expect(disposedAgents).toEqual([id]);
    expect(disposedSessions).toEqual([id]);
    expect(s.ctx.agents.get(SessionId(id))).toBeUndefined();
    expect(s.ctx.sessions.get(SessionId(id))).toBeUndefined();
  });
});

describe('agents.resume', () => {
  it('escalates a pre-mirrored read session to write control', async () => {
    const s = track(await setupProxy());
    s.broker.createSession({});
    s.broker.emit('s-1', 'turn/start', { turn: 1 });
    await s.proxy.ready;
    await s.proxy.reconcile();
    await vi.waitFor(() => expect(s.proxy.mirrors.has('s-1')).toBe(true));
    expect(s.broker.holderOf('s-1')).toBeNull();

    const handle = await s.ctx.agents.resume({ resumeSessionId: SessionId('s-1') });
    expect(handle.agent.id).toBe('s-1');
    expect(s.broker.holderOf('s-1')).not.toBeNull();
    expect(handle.agent.session.events.map((e) => e.seq)).toEqual([0]);

    // The proxy keeps owning the pre-mirror: dispose only releases control.
    await handle.dispose();
    expect(s.broker.holderOf('s-1')).toBeNull();
    expect(s.ctx.agents.get(SessionId('s-1'))).toBeDefined();
  });

  it('cold resume: cold-reads history, attaches write, then goes live', async () => {
    const s = track(await setupProxy());
    // A session the proxy never pre-mirrored: register it AFTER the initial
    // reconcile settled (no sessions-changed fanout for direct fake inserts).
    await s.proxy.ready;
    expect(s.proxy.mirrors.size).toBe(0);
    s.broker.createSession({});
    s.broker.emit('s-1', 'turn/start', { turn: 1 });
    s.broker.emit('s-1', 'turn/end', { turn: 1, reason: { kind: 'completed' } });

    const handle = await s.ctx.agents.resume({ resumeSessionId: SessionId('s-1') });
    expect(handle.agent.session.events.map((e) => e.seq)).toEqual([0, 1]);
    expect(s.broker.holderOf('s-1')).not.toBeNull();

    // Live events keep mirroring after the resume.
    const events: SessionEvent[] = [];
    s.ctx.on('session/event', (_session, event) => events.push(event as SessionEvent));
    s.broker.emit('s-1', 'turn/start', { turn: 2 });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({ type: 'turn/start', seq: 2 });

    await handle.dispose();
    expect(s.ctx.sessions.get(SessionId('s-1'))).toBeUndefined();
  });
});
