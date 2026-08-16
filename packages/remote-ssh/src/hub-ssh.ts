/**
 * `SshRemoteHub`: ssh2-backed implementation of the {@link RemoteHub} service
 * definition from `@dsh-remote/remote`.
 *
 * The hub holds one {@link SshTransport} per target and hands it out to the
 * live-mode providers (fs-ssh etc.). Connections are established lazily via
 * {@link SshRemoteHub.connect}; concurrent `connect()` calls for one target
 * share a single in-flight attempt.
 */

import { randomBytes } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import {
  RemoteHub,
  TransportError,
  type ConnectionStatus,
  type RemoteTarget,
  type RemoteTargetInfo,
  type RemoteTransport,
  type SshConnectHooks,
} from '@dsh-remote/remote';
import { SshTransport } from './ssh-transport.js';

interface TargetEntry {
  id: string;
  config: RemoteTarget;
  status: ConnectionStatus;
  transport?: SshTransport;
  /** In-flight `connect()` attempt, shared by concurrent callers. */
  connecting?: Promise<SshTransport>;
  runtimeRoot?: string;
}

export namespace SshRemoteHub {
  /** ssh2-implementation options, extending the service-level {@link RemoteHub.Config}. */
  export interface Config extends RemoteHub.Config {
    /**
     * Targets registered at startup (declarative equivalent of
     * {@link SshRemoteHub.addTarget}); bundle patches use this to wire a
     * target from configuration alone.
     */
    targets?: RemoteTarget[];
    /**
     * Connect every declared target as soon as the plugin activates.
     * Per-target failures are logged and leave the target `disconnected`
     * (retry via `connect(id)`); they never fail plugin startup.
     */
    autoConnect?: boolean;
  }
}

/**
 * Connection-owner service registered as `ctx.remoteHub`.
 *
 * The v1 registry is in-memory; the `RemoteTarget` shape and the
 * add/remove/list accessors are designed so a persistent store can be
 * swapped in without changing consumers.
 */
export class SshRemoteHub extends RemoteHub {
  private readonly entries = new Map<string, TargetEntry>();
  private readonly config: SshRemoteHub.Config;

  constructor(ctx: Context, config: SshRemoteHub.Config = {}) {
    super(ctx);
    this.config = config;
    for (const target of config.targets ?? []) this.addTarget(target);
    if (config.autoConnect) {
      for (const id of this.entries.keys()) {
        this.connect(id).catch((err: unknown) => {
          ctx.logger('remote-ssh').warn('auto-connect to target %s failed: %s', id, (err as Error)?.message ?? err);
        });
      }
    }
    // Close every connection when the owning fiber (plugin) unloads.
    ctx.effect(() => () => this.dispose(), 'remoteHub: close connections');
  }

  /** Register a target; returns its id. Throws on id collision. */
  override addTarget(config: RemoteTarget): string {
    const id = config.id ?? randomBytes(4).toString('hex');
    if (this.entries.has(id)) throw new Error(`duplicate remote target id: ${id}`);
    this.entries.set(id, { id, config: { ...config, id }, status: 'disconnected' });
    return id;
  }

  /** Unregister a target, closing its connection first if needed. */
  override async removeTarget(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    await this.disconnect(id);
    this.entries.delete(id);
  }

  /** List all registered targets with their current status. */
  override listTargets(): RemoteTargetInfo[] {
    return [...this.entries.values()].map((entry) => {
      const info: RemoteTargetInfo = { id: entry.id, status: entry.status };
      if (entry.config.title !== undefined) info.title = entry.config.title;
      if (entry.runtimeRoot !== undefined) info.runtimeRoot = entry.runtimeRoot;
      return info;
    });
  }

  /** Look up a target's registration. */
  override getTarget(id: string): RemoteTarget | undefined {
    return this.entries.get(id)?.config;
  }

  /** The live transport for a target, if currently connected. */
  override get(id: string): RemoteTransport | undefined {
    const entry = this.entries.get(id);
    return entry?.status === 'connected' ? entry.transport : undefined;
  }

  /** Current lifecycle state of a target (`disconnected` when unknown). */
  override status(id: string): ConnectionStatus {
    return this.entries.get(id)?.status ?? 'disconnected';
  }

  /** Absolute runtime-root path on the remote host, once connected. */
  override runtimeRoot(id: string): string | undefined {
    return this.entries.get(id)?.runtimeRoot;
  }

  /**
   * Connect to a target, idempotently.
   *
   * An already-connected target returns its existing transport; concurrent
   * calls while a connection is being established share the same promise.
   * On success the per-session runtime root (`~/.cache/dsh-remote/<hex>`)
   * is created on the remote host; failure there fails the connection and
   * cleans up the transport.
   */
  override connect(id: string): Promise<RemoteTransport> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`unknown remote target: ${id}`);
    if (entry.status === 'connected' && entry.transport) return Promise.resolve(entry.transport);
    if (entry.connecting) return entry.connecting;
    const connecting = this.establish(entry);
    entry.connecting = connecting;
    return connecting;
  }

  /** Close a target's connection (no-op when already disconnected). */
  override async disconnect(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    // Let an in-flight attempt settle first, then tear down whatever it
    // produced (the attempt may itself have failed and cleaned up).
    if (entry.connecting) {
      await entry.connecting.catch(() => undefined);
    }
    const transport = entry.transport;
    const wasActive = entry.status === 'connected' || entry.status === 'degraded';
    entry.transport = undefined;
    entry.runtimeRoot = undefined;
    entry.status = 'disconnected';
    if (transport) await transport.close();
    if (wasActive) this.ctx.emit('remote/disconnected', id);
  }

  /** Best-effort close of every connection; used at plugin disposal. */
  private async dispose(): Promise<void> {
    const ids = [...this.entries.keys()];
    await Promise.allSettled(ids.map((id) => this.disconnect(id)));
  }

  /** Run one connection attempt for an entry. */
  private async establish(entry: TargetEntry): Promise<SshTransport> {
    entry.status = 'connecting';
    let transport: SshTransport | undefined;
    try {
      const hooks: SshConnectHooks = {};
      if (this.config.hostVerifier) hooks.hostVerifier = this.config.hostVerifier;
      transport = await SshTransport.connect(entry.config.ssh, hooks);
      const root = await this.setupRuntimeRoot(transport, entry.id);
      entry.transport = transport;
      entry.runtimeRoot = root;
      entry.status = 'connected';
      transport.onUnexpectedClose = () => {
        // Ignore stale callbacks from transports we already replaced.
        if (entry.transport !== transport) return;
        entry.status = 'degraded';
        entry.runtimeRoot = undefined;
        this.ctx.emit('remote/degraded', entry.id);
      };
      this.ctx.emit('remote/connected', entry.id);
      return transport;
    } catch (err) {
      entry.status = 'disconnected';
      await transport?.close().catch(() => undefined);
      throw err;
    } finally {
      entry.connecting = undefined;
    }
  }

  /**
   * Create the per-session runtime root on the remote host
   * (`$HOME/.cache/dsh-remote/<16 random hex>`, mode 700) and return its
   * resolved absolute path.
   */
  private async setupRuntimeRoot(transport: RemoteTransport, targetId: string): Promise<string> {
    const suffix = randomBytes(8).toString('hex');
    const rel = `${this.config.runtimeRootBase ?? '.cache/dsh-remote'}/${suffix}`;
    const proc = await transport.exec(
      `mkdir -p "$HOME/${rel}" && chmod 700 "$HOME/${rel}" && cd "$HOME/${rel}" && pwd -P`,
    );
    const chunks: Uint8Array[] = [];
    for await (const chunk of proc.stdout) chunks.push(chunk);
    const { code } = await proc.done;
    const root = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8').trim();
    if (code !== 0 || !root) {
      throw new TransportError(`failed to create runtime root for target ${targetId}`, 'IO_ERROR');
    }
    return root;
  }
}
