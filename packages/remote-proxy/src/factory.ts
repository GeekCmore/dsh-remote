/**
 * `RemoteAgentFactory`: the `AgentFactory` registered on the real upstream
 * `AgentRegistry` via `setFactory`, so `ctx.agents.create()` /
 * `ctx.agents.resume()` — the upstream creation contract frontends already
 * use — produce remote-backed agents.
 *
 * - `createAgent`: creates the REMOTE session first (`client.create`,
 *   write-mode attach), then mirrors it. Caller-supplied `options.sessionId`
 *   is forwarded through the additive `requested-session-id` capability.
 *   A caller-supplied `seed` is rejected: a remote fork must match the
 *   daemon's own log prefix, so forking routes through `handle.fork` /
 *   `sessions.forkRemote` instead.
 * - `resume`: an already-mirrored session is escalated in place
 *   (`acquireWrite`, failing with REMOTE_SESSION_LOCKED when another client
 *   holds the lease) and the returned handle's `dispose()` only releases
 *   control — the proxy-owned pre-mirror stays. A cold session goes through
 *   `ctx.sessionPersistence.prepare` (cold read, no remote resume), then a
 *   write attach, then a history top-up before publication.
 */
import type { Context } from '@deepseek-ai/cordis';
import type {
  AgentFactory,
  AgentHandle,
  CreateAgentOptions,
  ResumeAgentOptions,
} from '@deepseek-ai/dsh-agent';
import type { RemoteClient } from '@dsh-remote/client';
import type { SessionMirror, MirrorOptions } from './mirror.js';
import type { RemoteSessionPersistence } from './persistence.js';

export interface RemoteAgentFactoryDeps {
  ctx: Context;
  client: RemoteClient;
  targetId: string;
  persistence: RemoteSessionPersistence;
  /** Live mirrors by session id (orchestrator-owned). */
  mirrors: Map<string, SessionMirror>;
  /** Create + register a mirror (orchestrator-owned, incl. teardown bookkeeping). */
  mirrorSession(opts: MirrorOptions & { ownerCtx: Context }): Promise<SessionMirror>;
}

export class RemoteAgentFactory implements AgentFactory {
  constructor(private readonly deps: RemoteAgentFactoryDeps) {}

  async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    if (options.seed !== undefined) {
      throw new Error(
        '@dsh-remote/proxy: agents.create({ seed }) is unsupported — a remote fork must match ' +
          'the daemon log prefix; use sessions.forkRemote(source, { atSeq }) instead',
      );
    }
    options.signal?.throwIfAborted();
    const handle = await this.deps.client.create(this.deps.targetId, {
      requestedSessionId: options.sessionId as unknown as string,
      ...(options.meta?.cwd !== undefined ? { cwd: options.meta.cwd } : {}),
    });
    try {
      const mirror = await this.deps.mirrorSession({
        handle,
        ownerCtx,
        owner: ownerCtx.agent,
        ...(options.agentOptions !== undefined ? { agentOptions: options.agentOptions } : {}),
        ...(options.setup !== undefined ? { setup: options.setup } : {}),
        sessionStart: 'startup',
        meta: {
          ...(options.meta?.cwd !== undefined ? { cwd: options.meta.cwd } : {}),
        },
      });
      return { agent: mirror.agent, dispose: () => this.disposeOwned(mirror) };
    } catch (err) {
      await handle.detach().catch(() => undefined);
      throw err;
    }
  }

  async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    options.signal?.throwIfAborted();
    const id = options.resumeSessionId;
    const existing = this.deps.mirrors.get(id as unknown as string);
    if (existing !== undefined) {
      // Escalate the pre-mirrored (read) handle to write control; the proxy
      // keeps owning the mirror, so dispose only releases the lease.
      await existing.handle.acquireWrite(false);
      return {
        agent: existing.agent,
        dispose: async () => {
          await existing.handle.releaseControl().catch(() => undefined);
        },
      };
    }
    const prep = await this.deps.persistence.prepare(id, options.signal);
    let handle;
    try {
      handle = await this.deps.client.attach(this.deps.targetId, id as unknown as string, {
        mode: 'write',
      });
    } catch (err) {
      prep[Symbol.dispose]();
      throw err;
    }
    try {
      const mirror = await this.deps.mirrorSession({
        handle,
        ownerCtx,
        owner: ownerCtx.agent,
        ...(options.agentOptions !== undefined ? { agentOptions: options.agentOptions } : {}),
        ...(options.setup !== undefined ? { setup: options.setup } : {}),
        sessionStart: 'resume',
        seedSession: prep.session,
      });
      // Publication consumed the preparation.
      prep[Symbol.dispose]();
      return { agent: mirror.agent, dispose: () => this.disposeOwned(mirror) };
    } catch (err) {
      prep[Symbol.dispose]();
      await handle.detach().catch(() => undefined);
      throw err;
    }
  }

  private async disposeOwned(mirror: SessionMirror): Promise<void> {
    await mirror.dispose({ detachHandle: true, releaseControl: true });
    this.deps.mirrors.delete(mirror.handle.sessionId);
  }
}
