/**
 * {@link RemoteClient}: the cordis-free daemon-protocol client. Owns the
 * per-target {@link TargetConnection} registry (publicly reachable via
 * {@link RemoteClient.connection} — no more private-map poking for
 * approvals/monitors), the idempotent (target, session) handle registry, and
 * a plain callback channel for sessions-changed fanout.
 *
 * The cordis `ctx.remoteSessions` adapter (`@dsh-remote/remote-daemon`) is a
 * thin wrapper over this class; anything testable lives here.
 */
import {
  Capabilities,
  Methods,
  RemoteError,
  type CatalogKind,
  type CatalogListResult,
  type SessionAttachResult,
  type SessionCreateResult,
  type SessionListResult,
  type SessionSummary,
} from '@dsh-remote/core';
import { TargetConnection, CLIENT_CAPABILITIES } from './connection.js';
import type { TargetConnector } from './connector.js';
import { DaemonAgentHandle } from './handle.js';
import type {
  AttachOptions,
  CreateRemoteSessionOptions,
  RemoteAttachMode,
  RemoteClientHandle,
  RemoteSessionSummary,
} from './types.js';

/** Configuration for {@link RemoteClient}. */
export interface RemoteClientConfig {
  /**
   * Resolve a target's `pairingTokenRef` to the pairing token. Injected so
   * the client never touches the credential store directly.
   */
  resolveToken: (ref: string) => Promise<string>;
  /** Remote command serving the daemon protocol. Default `dsh-remote-backend serve`. */
  backendCommand?: string;
  /** Reconnect backoff: initial delay, delay cap, and attempt cap (default unlimited). */
  reconnect?: {
    initialDelayMs?: number;
    maxDelayMs?: number;
    maxAttempts?: number;
  };
  /** Default deadline for one JSON-RPC call. Defaults to 30 seconds. */
  requestTimeoutMs?: number;
  /**
   * Capability bits advertised in the handshake hello. Defaults to the full
   * known set ({@link CLIENT_CAPABILITIES}).
   */
  capabilities?: string[];
}

/** Print-safe registry key for one (target, session) handle. */
function handleKey(targetId: string, sessionId: string): string {
  return `${targetId}::${sessionId}`;
}

function mapSummary(s: SessionSummary): RemoteSessionSummary {
  const out: RemoteSessionSummary = {
    sessionId: s.sessionId,
    createdAt: typeof s.createdAt === 'number' ? s.createdAt : 0,
    state: s.status === 'ended' ? 'cold' : 'active',
    attached: s.attachedClients > 0,
  };
  if (s.title !== undefined) out.title = s.title;
  if (s.cwd) out.cwd = s.cwd;
  if (typeof s.controller === 'string') out.controller = s.controller;
  return out;
}

export class RemoteClient {
  private readonly conns = new Map<string, TargetConnection>();
  private readonly handles = new Map<string, DaemonAgentHandle>();
  private readonly changedCbs = new Set<(targetId: string) => void>();
  private readonly config;
  private disposed = false;

  constructor(
    private readonly connector: TargetConnector,
    config: RemoteClientConfig,
  ) {
    if (typeof config?.resolveToken !== 'function') {
      throw new Error('RemoteClient: config.resolveToken is required');
    }
    this.config = {
      resolveToken: (ref: string) => config.resolveToken(ref),
      backendCommand: config.backendCommand ?? 'dsh-remote-backend serve',
      reconnectInitialDelayMs: config.reconnect?.initialDelayMs ?? 250,
      reconnectMaxDelayMs: config.reconnect?.maxDelayMs ?? 10_000,
      reconnectMaxAttempts: config.reconnect?.maxAttempts ?? Number.POSITIVE_INFINITY,
      requestTimeoutMs: config.requestTimeoutMs ?? 30_000,
      capabilities: config.capabilities ?? [...CLIENT_CAPABILITIES],
    };
  }

  /**
   * Subscribe to sessions-changed fanout: fired when a session set may have
   * changed (a session was created here, reported `ended`, or detachAll ran
   * for the target). Listeners typically re-run {@link list}.
   */
  onSessionsChanged(cb: (targetId: string) => void): () => void {
    this.changedCbs.add(cb);
    return () => {
      this.changedCbs.delete(cb);
    };
  }

  /**
   * The daemon channel for a target, connected. Public on purpose: channel
   * level consumers (approval/monitor escape hatches, raw protocol calls)
   * should not need to poke private registries.
   */
  async connection(targetId: string): Promise<TargetConnection> {
    if (this.disposed) {
      throw new RemoteError('REMOTE_CONN_LOST', 'remote client is disposed');
    }
    let conn = this.conns.get(targetId);
    if (!conn) {
      conn = new TargetConnection(this.connector, targetId, {
        ...this.config,
        onSessionEnded: () => this.emitChanged(targetId),
      });
      this.conns.set(targetId, conn);
    }
    await conn.ensureConnected();
    return conn;
  }

  /**
   * Capability bits the target's backend advertised in its handshake
   * challenge, or undefined when the target has no live channel. Empty set
   * means a connected backend that predates capability negotiation.
   */
  capabilitiesOf(targetId: string): ReadonlySet<string> | undefined {
    const conn = this.conns.get(targetId);
    if (!conn?.connected) return undefined;
    return conn.capabilities;
  }

  /** List the sessions a target's daemon knows about. */
  async list(targetId: string): Promise<RemoteSessionSummary[]> {
    const conn = await this.connection(targetId);
    const result = await conn.call<SessionListResult>(Methods.SessionList);
    return (result.sessions as SessionSummary[]).map(mapSummary);
  }

  /**
   * Attach to a session, idempotently: a live handle for (target, session) is
   * returned as-is (escalating to write control first when requested). A write
   * attach against a taken lease fails with REMOTE_SESSION_LOCKED unless
   * `opts.force` preempts the holder.
   */
  async attach(
    targetId: string,
    sessionId: string,
    opts: AttachOptions = {},
  ): Promise<RemoteClientHandle> {
    const mode: RemoteAttachMode = opts.mode ?? 'read';
    const key = handleKey(targetId, sessionId);
    const existing = this.handles.get(key);
    if (existing && !existing.detached) {
      if (mode === 'write') await existing.acquireWrite(opts.force ?? false);
      return existing;
    }
    const conn = await this.connection(targetId);
    const result = await conn.call<SessionAttachResult>(Methods.SessionAttach, {
      sessionId,
      mode,
      ...(opts.force ? { force: true } : {}),
    });
    const handle = new DaemonAgentHandle({
      conn,
      sessionId,
      mode,
      initialLastSeq: result.lastSeq,
      ...(result.pendingInteractions !== undefined
        ? { pendingInteractions: result.pendingInteractions }
        : {}),
      onDetached: () => {
        this.handles.delete(key);
      },
    });
    conn.subscribe(handle);
    this.handles.set(key, handle);
    return handle;
  }

  /** Create a session on the daemon and attach to it in write mode. */
  async create(
    targetId: string,
    opts: CreateRemoteSessionOptions = {},
  ): Promise<RemoteClientHandle> {
    const conn = await this.connection(targetId);
    if (
      opts.requestedSessionId !== undefined &&
      !conn.capabilities.has(Capabilities.RequestedSessionId)
    ) {
      throw new RemoteError(
        'REMOTE_CAPABILITY_UNSUPPORTED',
        `target "${targetId}": backend does not support caller-selected session ids`,
      );
    }
    const result = await conn.call<SessionCreateResult>(Methods.SessionCreate, {
      ...(opts.requestedSessionId !== undefined
        ? { requestedSessionId: opts.requestedSessionId }
        : {}),
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts.title !== undefined ? { title: opts.title } : {}),
    });
    this.emitChanged(targetId);
    return this.attach(targetId, result.sessionId, { mode: 'write' });
  }

  /**
   * List a daemon catalog (models, skills, agent presets). Requires the
   * backend's `catalogs` capability; fail-fast REMOTE_CAPABILITY_UNSUPPORTED
   * otherwise.
   */
  async listCatalog<K extends CatalogKind>(
    targetId: string,
    kind: K,
  ): Promise<Extract<CatalogListResult, { kind: K }>> {
    const conn = await this.connection(targetId);
    if (!conn.capabilities.has(Capabilities.Catalogs)) {
      throw new RemoteError(
        'REMOTE_CAPABILITY_UNSUPPORTED',
        `target "${targetId}": backend does not support catalog.list (missing "catalogs" capability)`,
      );
    }
    return conn.call<Extract<CatalogListResult, { kind: K }>>(Methods.CatalogList, { kind });
  }

  /** Detach every handle — of one target, or across all targets. */
  async detachAll(targetId?: string): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const handle of [...this.handles.values()]) {
      if (targetId !== undefined && handle.targetId !== targetId) continue;
      pending.push(handle.detach().catch(() => undefined));
    }
    await Promise.all(pending);
    if (targetId !== undefined) this.emitChanged(targetId);
  }

  /** Detach all handles and close every daemon channel. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.detachAll();
    await Promise.all([...this.conns.values()].map((conn) => conn.close()));
    this.conns.clear();
  }

  private emitChanged(targetId: string): void {
    for (const cb of [...this.changedCbs]) cb(targetId);
  }
}
