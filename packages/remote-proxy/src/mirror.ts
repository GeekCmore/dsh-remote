/**
 * `SessionMirror`: one remote session mirrored into the local upstream seams.
 *
 * Bootstrap (seq-exact replay):
 * 1. `handle.onEvent` is registered FIRST (synchronously after attach) and
 *    buffers live events, so nothing is lost while history is read;
 * 2. the full remote history is paged (handle.history, seq-paginated) and
 *    appended into a fresh REAL `Session` BEFORE `store.enter` — appends on
 *    an unentered session do not publish, so history replay does not flood
 *    `session/event` (and no synthetic `session/end-seed` is introduced,
 *    which a constructor seed would do, shifting every later seq);
 * 3. the agent facade is fabricated, its dsh-scope context minted (key = the
 *    facade itself, matching the registry's `scopeTarget(agent, agent)`
 *    carrier), and the caller's `setup` composition hook runs unpublished;
 * 4. publication: `sessions.enter` → `sessions.announce` →
 *    `agents.enter` → `agents.announce` → optional `agent/session-start`;
 * 5. the buffered live events drain and the mirror goes live: every remote
 *    event is appended in seq order (publishing `session/event` through the
 *    store's genuine hooks), and durable inbox splices feed the facade's
 *    real `Inbox` projection.
 *
 * Seq invariant: for every mirrored event `wire.seq === session.seq`. A
 * violation (gap, non-contiguous history, append validation failure) marks
 * the mirror FAILED: appends stop (a gutted mirror is worse than a stuck
 * one) and the condition is logged. Reconnects are safe: the client dedups
 * by seq cursor, so delivery simply continues.
 *
 * Local writes are rejected outright: {@link guardMirrorAppend} shadows
 * `session.append` on every mirrored session so that ONLY the mirror may
 * write. Without the guard, stock dsh-base reactor plugins corrupt the
 * mirror — e.g. `dsh-session-title` answers the first mirrored user/message
 * with a deferred local `session/title` append, which desyncs seq numbering
 * and freezes the mirror at the next wire event. The remote host owns the
 * log; titles and friends arrive over the wire.
 */
import type { Context, Logger } from '@deepseek-ai/cordis';
import {
  AgentRegistry,
  emitAgentEvent,
  type Agent,
  type AgentOptions,
  type AgentSetup,
  type SessionStartSource,
} from '@deepseek-ai/dsh-agent';
import { createScope, type Scope } from '@deepseek-ai/dsh-scope';
import { SessionId, type Session } from '@deepseek-ai/dsh-session';
import type { RemoteClient, RemoteClientHandle } from '@dsh-remote/client';
import { RemoteAgentFacade, type InboxSplice } from './agent.js';
import type { InteractionBridges } from './bridges.js';
import { appendMirroredEvent, readRemoteHistory, type MirroredWireEvent } from './events.js';
import type { RemoteSessionStore } from './store.js';

export interface MirrorDeps {
  ctx: Context;
  client: RemoteClient;
  targetId: string;
  store: RemoteSessionStore;
  registry: AgentRegistry;
  bridges: InteractionBridges;
}

/**
 * Shadow `session.append` on a mirrored session so only the mirror itself
 * may write (module doc): local reactor plugins holding the session would
 * otherwise corrupt the seq-exact log. The returned `run` executes `fn` with
 * the mirror append window open; any append outside it throws.
 */
function guardMirrorAppend(session: Session): { run<T>(fn: () => T): T } {
  const raw = session.append.bind(session) as (...args: unknown[]) => unknown;
  let inside = false;
  const guarded = (...args: unknown[]): unknown => {
    if (!inside) {
      throw new Error(
        `session "${session.id as unknown as string}" is a remote mirror: its log is owned by ` +
          'the remote host; local appends are rejected',
      );
    }
    return raw(...args);
  };
  (session as { append: unknown }).append = guarded;
  return {
    run: <T>(fn: () => T): T => {
      inside = true;
      try {
        return fn();
      } finally {
        inside = false;
      }
    },
  };
}

export interface MirrorOptions {
  handle: RemoteClientHandle;
  /** Context whose fiber owns this mirror (plugin ctx for pre-mirrors, caller ctx for factory flows). */
  ownerCtx: Context;
  /** Runtime owner agent (subagent parenting); undefined for runtime roots. */
  owner?: Agent;
  agentOptions?: AgentOptions;
  /** Upstream composition hook (create/resume); runs unpublished. */
  setup?: AgentSetup;
  /** Emit `agent/session-start` with this source after publication. */
  sessionStart?: SessionStartSource;
  /** Resume flow: the unpublished session from `sessionPersistence.prepare` (history prefix inside). */
  seedSession?: Session;
  /** Creation metadata for the local session header (new mirrors only). */
  meta?: { cwd?: string; createdAt?: number };
}

export class SessionMirror {
  readonly session: Session;
  readonly agent: RemoteAgentFacade;
  readonly handle: RemoteClientHandle;
  /** Set when a seq/validation failure froze this mirror. */
  failed: Error | undefined;
  private readonly logger: Logger;
  private readonly offEvent: () => void;
  private readonly guard: { run<T>(fn: () => T): T };
  private readonly scope: Scope;
  private readonly detachSession: () => void;
  private readonly detachAgent: () => void;
  private disposed = false;

  private constructor(
    private readonly deps: MirrorDeps,
    opts: MirrorOptions,
    parts: {
      session: Session;
      agent: RemoteAgentFacade;
      scope: Scope;
      guard: { run<T>(fn: () => T): T };
      detachSession: () => void;
      detachAgent: () => void;
      offEvent: () => void;
    },
  ) {
    this.handle = opts.handle;
    this.session = parts.session;
    this.agent = parts.agent;
    this.scope = parts.scope;
    this.guard = parts.guard;
    this.detachSession = parts.detachSession;
    this.detachAgent = parts.detachAgent;
    this.offEvent = parts.offEvent;
    this.logger = deps.ctx.logger('dsh-remote/proxy');
  }

  /**
   * Full bootstrap. Registers the event tap synchronously, then pages history
   * and publishes. `options.setup` runs (and its commit fires) while both the
   * session and the agent are still unpublished, matching the upstream
   * factory contract.
   */
  static async create(deps: MirrorDeps, opts: MirrorOptions): Promise<SessionMirror> {
    const { handle } = opts;
    const logger = deps.ctx.logger('dsh-remote/proxy');
    const sessionId = SessionId(handle.sessionId);

    // 1. Tap live events BEFORE any await past this point could drop one.
    const buffered: MirroredWireEvent[] = [];
    let live = false;
    let mirror: SessionMirror | undefined;
    const appendLive = (wire: MirroredWireEvent): void => {
      if (!mirror) return;
      mirror.appendEvent(wire);
    };
    const offEvent = handle.onEvent((event) => {
      const wire = event as unknown as MirroredWireEvent;
      if (!live) {
        buffered.push(wire);
        return;
      }
      appendLive(wire);
    });

    try {
      // 2. History top-up (a resume seedSession already holds [0..seq)).
      const fromSeq = opts.seedSession?.seq ?? 0;
      const history = await readRemoteHistory(
        (params) =>
          handle.history(params) as Promise<{
            entries: { seq: number; event: MirroredWireEvent }[];
            hasMore: boolean;
          }>,
        fromSeq,
      );

      // 3. The session: reused from persistence.prepare, or prepared fresh.
      const session =
        opts.seedSession ??
        deps.store.prepare(sessionId, {
          meta: {
            ...(opts.meta?.cwd ? { cwd: opts.meta.cwd } : {}),
            ...(opts.meta?.createdAt !== undefined ? { createdAt: opts.meta.createdAt } : {}),
          },
        });
      // Reject local appends from here on (module doc); the mirror writes
      // through the guard window only.
      const guard = guardMirrorAppend(session);
      guard.run(() => {
        for (const wire of history) {
          if (wire.seq !== session.seq) {
            throw new Error(
              `session "${handle.sessionId}": history replay diverged (expected seq ${session.seq}, got ${wire.seq})`,
            );
          }
          appendMirroredEvent(session, wire);
        }
      });

      // 4. Facade + scope (key = the facade; parent = the runtime owner).
      const agent = new RemoteAgentFacade({
        ctx: deps.ctx,
        session,
        handle,
        ...(opts.agentOptions !== undefined ? { options: opts.agentOptions } : {}),
      });
      const scope = createScope(
        opts.ownerCtx,
        agent,
        opts.owner !== undefined ? { parent: opts.owner } : {},
      );
      agent.setAgentContext(scope.ctx.extend({ agent }));

      // 5. Unpublished setup composition; its synchronous commit fires
      //    immediately before publication (the upstream factory contract).
      const commit = await opts.setup?.(agent.ctx);
      commit?.commit();

      // 6. Publish session then agent through the agent-scoped context, so
      //    the store/registry capture the agent's scope carrier.
      const scopedStore = agent.ctx.sessions as RemoteSessionStore;
      const detachSession = scopedStore.enter(session);
      try {
        scopedStore.announce(session);
      } catch (err) {
        detachSession();
        throw err;
      }
      const detachAgent = deps.registry.enter(agent, opts.owner);
      try {
        deps.registry.announce(agent);
      } catch (err) {
        detachAgent();
        detachSession();
        throw err;
      }
      agent.markAnnounced();
      if (opts.sessionStart !== undefined) {
        emitAgentEvent(deps.ctx, agent, 'agent/session-start', { source: opts.sessionStart });
      }

      mirror = new SessionMirror(deps, opts, {
        session,
        agent,
        scope,
        guard,
        detachSession,
        detachAgent,
        offEvent,
      });
      deps.bridges.wire(handle, agent);

      // 7. Go live: drain buffered events, then append directly.
      live = true;
      for (const wire of buffered) mirror.appendEvent(wire);
      return mirror;
    } catch (err) {
      offEvent();
      logger.warn(`session "${handle.sessionId}": mirror bootstrap failed: ${String(err)}`);
      throw err;
    }
  }

  /** Append one live wire event, upholding the seq-exact contract. */
  private appendEvent(wire: MirroredWireEvent): void {
    if (this.failed) return;
    if (wire.seq !== this.session.seq) {
      this.fail(
        new Error(
          `session "${this.handle.sessionId}": remote event seq ${wire.seq} breaks the mirror ` +
            `(next local seq is ${this.session.seq}); mirroring stopped`,
        ),
      );
      return;
    }
    try {
      this.guard.run(() => appendMirroredEvent(this.session, wire));
    } catch (err) {
      this.fail(
        err instanceof Error
          ? err
          : new Error(`session "${this.handle.sessionId}": append rejected: ${String(err)}`),
      );
      return;
    }
    if (wire.type === 'agent/inbox/spliced') {
      this.agent.feedInboxSplice(wire.data as InboxSplice);
    }
  }

  private fail(err: Error): void {
    this.failed = err;
    this.logger.warn(err.message);
  }

  /**
   * Tear the mirror down in the upstream order: release the remote lease,
   * unregister the agent (`agent/disposed`), remove the session
   * (`session/disposed`), unwind the scoped world, and finally drop the
   * attachment. `detachHandle: false` keeps the wire attachment (shared
   * pre-mirror) and only releases write control.
   */
  async dispose(opts: { detachHandle?: boolean; releaseControl?: boolean } = {}): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const detachHandle = opts.detachHandle ?? true;
    if (opts.releaseControl !== false && this.handle.mode === 'write') {
      await this.handle.releaseControl().catch((err) => {
        this.logger.warn(`session "${this.handle.sessionId}": releaseControl failed: ${String(err)}`);
      });
    }
    this.deps.bridges.unwire(this.handle.sessionId);
    this.offEvent();
    this.detachAgent();
    this.detachSession();
    await this.scope.dispose();
    if (detachHandle) {
      await this.handle.detach().catch((err) => {
        this.logger.warn(`session "${this.handle.sessionId}": detach failed: ${String(err)}`);
      });
    }
  }
}
