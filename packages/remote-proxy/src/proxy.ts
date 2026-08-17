/**
 * `RemoteProxy`: the orchestrator. Mounts the real upstream services on the
 * plugin context — `RemoteSessionStore` (`sessions`), `AgentRegistry`
 * (`agents`, with {@link RemoteAgentFactory} as its factory),
 * `RemoteSessionPersistence` (`sessionPersistence`) — and owns the mirror
 * set: every ACTIVE session of the configured target is pre-mirrored
 * (read-mode attach) so `ctx.sessions.list()` / `ctx.agents.list()` and the
 * `session/created` / `agent/created` announcements work for sessions the
 * local process never created. `remote/sessions-changed` reconciles the set
 * (new sessions get mirrored; ended sessions are torn down locally — the
 * remote side is never disturbed).
 */
import type { Context, Logger } from '@deepseek-ai/cordis';
import { AgentRegistry } from '@deepseek-ai/dsh-agent';
import type { Session, SessionForkSource, SessionId } from '@deepseek-ai/dsh-session';
import type { RemoteClient } from '@dsh-remote/client';
import { InteractionBridges } from './bridges.js';
import { RemoteCatalogs } from './catalogs.js';
import { RemoteAgentFactory } from './factory.js';
import { SessionMirror, type MirrorOptions } from './mirror.js';
import { RemoteSessionPersistence } from './persistence.js';
import { RemoteSessionStore } from './store.js';

export interface RemoteProxyConfig {
  /** Daemon target id every client call uses (single target per profile in v1). */
  targetId?: string;
}

export class RemoteProxy {
  readonly store: RemoteSessionStore;
  readonly registry: AgentRegistry;
  readonly persistence: RemoteSessionPersistence;
  readonly bridges: InteractionBridges;
  readonly factory: RemoteAgentFactory;
  readonly catalogs: RemoteCatalogs;
  /** Live mirrors by session id. */
  readonly mirrors = new Map<string, SessionMirror>();
  /** Resolves when the activation-time reconcile (initial pre-mirror sweep) settled. */
  readonly ready: Promise<void>;
  private readonly inflight = new Map<string, Promise<SessionMirror>>();
  private readonly ctx: Context;
  private readonly client: RemoteClient;
  private readonly targetId: string;
  private readonly logger: Logger;
  private disposed = false;

  constructor(ctx: Context, config: RemoteProxyConfig, client: RemoteClient) {
    this.ctx = ctx;
    this.client = client;
    this.targetId = config.targetId ?? 'default';
    this.logger = ctx.logger('dsh-remote/proxy');
    this.catalogs = new RemoteCatalogs(ctx, client, this.targetId);
    this.store = new RemoteSessionStore(ctx);
    this.registry = new AgentRegistry(ctx);
    this.persistence = new RemoteSessionPersistence(ctx, {
      client,
      targetId: this.targetId,
    });
    this.bridges = new InteractionBridges({ ctx, client, targetId: this.targetId });
    this.factory = new RemoteAgentFactory({
      ctx,
      client,
      targetId: this.targetId,
      persistence: this.persistence,
      mirrors: this.mirrors,
      mirrorSession: (opts) => this.mirrorSession(opts),
    });
    this.registry.setFactory(this.factory);
    this.store.forkRemote = (source, opts) => this.forkRemote(source, opts);

    ctx.on('remote/sessions-changed', (targetId) => {
      if (targetId === this.targetId) void this.reconcile();
    });
    ctx.effect(() => () => this.dispose(), 'dsh-remote/proxy: detach mirrors and unwind services');
    this.ready = Promise.all([this.reconcile(), this.catalogs.ready]).then(() => undefined);
  }

  /** Create + register a mirror, de-duplicated by session id. */
  async mirrorSession(opts: MirrorOptions & { ownerCtx: Context }): Promise<SessionMirror> {
    const sessionId = opts.handle.sessionId;
    const existing = this.mirrors.get(sessionId);
    if (existing !== undefined) return existing;
    const pending = this.inflight.get(sessionId);
    if (pending !== undefined) return pending;
    const promise = SessionMirror.create(
      {
        ctx: this.ctx,
        client: this.client,
        targetId: this.targetId,
        store: this.store,
        registry: this.registry,
        bridges: this.bridges,
      },
      opts,
    );
    this.inflight.set(sessionId, promise);
    try {
      const mirror = await promise;
      this.mirrors.set(sessionId, mirror);
      return mirror;
    } finally {
      this.inflight.delete(sessionId);
    }
  }

  /** Async remote fork behind `store.forkRemote` (see the store override). */
  async forkRemote(
    source: SessionForkSource,
    opts: { boundary?: number; atSeq?: number } = {},
  ): Promise<Session> {
    const sourceId = (typeof source === 'string' ? source : source.id) as unknown as string;
    const mirror = this.mirrors.get(sourceId);
    if (mirror === undefined) {
      throw new Error(
        `@dsh-remote/proxy: forkRemote source "${sourceId}" is not a live mirrored session ` +
          '(fork a session visible in ctx.sessions.list())',
      );
    }
    const result = await mirror.handle.fork({
      ...(opts.boundary !== undefined ? { boundary: opts.boundary } : {}),
      ...(opts.atSeq !== undefined ? { atSeq: opts.atSeq } : {}),
    });
    const handle = await this.client.attach(this.targetId, result.sessionId, { mode: 'read' });
    const child = await this.mirrorSession({
      handle,
      ownerCtx: this.ctx,
      meta: { ...(mirror.session.header.cwd !== undefined ? { cwd: mirror.session.header.cwd } : {}) },
    });
    return child.session;
  }

  /**
   * Reconcile the mirror set with the daemon's session list: mirror new
   * active sessions (read mode), tear down mirrors whose session ended.
   * Runs automatically at activation and on `remote/sessions-changed`;
   * exposed for tests and explicit refreshes.
   */
  async reconcile(): Promise<void> {
    if (this.disposed) return;
    let summaries;
    try {
      summaries = await this.client.list(this.targetId);
    } catch (err) {
      this.logger.warn(`target "${this.targetId}": session list failed: ${String(err)}`);
      return;
    }
    const active = new Set(
      summaries.filter((s) => s.state === 'active').map((s) => s.sessionId),
    );
    for (const summary of summaries) {
      if (summary.state !== 'active') continue;
      if (this.mirrors.has(summary.sessionId) || this.inflight.has(summary.sessionId)) continue;
      try {
        const handle = await this.client.attach(this.targetId, summary.sessionId, { mode: 'read' });
        await this.mirrorSession({
          handle,
          ownerCtx: this.ctx,
          meta: {
            ...(summary.cwd ? { cwd: summary.cwd } : {}),
            ...(summary.createdAt ? { createdAt: summary.createdAt } : {}),
          },
        });
      } catch (err) {
        this.logger.warn(`session "${summary.sessionId}": pre-mirror failed: ${String(err)}`);
      }
    }
    for (const [sessionId, mirror] of [...this.mirrors]) {
      if (active.has(sessionId)) continue;
      // The session ended remotely (or vanished from the list): local
      // teardown only — the remote side is already gone or unreachable.
      this.mirrors.delete(sessionId);
      await mirror.dispose({ detachHandle: true, releaseControl: false }).catch((err) => {
        this.logger.warn(`session "${sessionId}": teardown failed: ${String(err)}`);
      });
    }
  }

  /** Detach every mirror; the services unwind with the plugin fiber. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const mirrors = [...this.mirrors.values()];
    this.mirrors.clear();
    for (const mirror of mirrors) {
      await mirror.dispose({ detachHandle: true }).catch((err) => {
        this.logger.warn(`session "${mirror.handle.sessionId}": dispose failed: ${String(err)}`);
      });
    }
  }
}

export type { SessionId };
