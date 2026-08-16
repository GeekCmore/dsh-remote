/**
 * `ctx.remoteHub`: registry of SSH targets and owner of their connections.
 *
 * This is the service *definition*: the abstract {@link RemoteHub} class, the
 * `Context`/`Events` augmentation, and the vocabulary types. The concrete
 * ssh2-backed implementation (`SshRemoteHub`) lives in
 * `@dsh-remote/remote-ssh`.
 *
 * The hub holds one transport per target and hands it out to the live-mode
 * providers (fs-ssh etc.). Connections are established lazily via
 * {@link RemoteHub.connect}; concurrent `connect()` calls for one target
 * share a single in-flight attempt.
 */

import { Context, Service } from '@deepseek-ai/cordis';
import type { RemoteTransport, SshTargetConfig } from './transport.js';

declare module '@deepseek-ai/cordis' {
  interface Context {
    remoteHub: RemoteHub;
  }

  interface Events {
    /** A target finished connecting (including runtime-root setup). */
    'remote/connected'(targetId: string): void;
    /** A target connection was closed (explicitly or during disposal). */
    'remote/disconnected'(targetId: string): void;
    /** A target connection dropped unexpectedly; reconnect to recover. */
    'remote/degraded'(targetId: string): void;
  }
}

/** A registered SSH target. */
export interface RemoteTarget {
  /** Stable identifier; generated when omitted. */
  id?: string;
  /** Human-readable label for UI surfaces. */
  title?: string;
  ssh: SshTargetConfig;
  /**
   * Reference to the pairing credential issued by the pairing-auth flow
   * (owned by `@dsh-remote/core`); reserved for the agent mode, unused by
   * the live SSH transport itself.
   */
  pairingTokenRef?: string;
}

/** Connection lifecycle state of a target. */
export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected' | 'degraded';

/** Public snapshot of one registered target. */
export interface RemoteTargetInfo {
  id: string;
  title?: string;
  status: ConnectionStatus;
  /** Absolute runtime-root path on the remote host, once connected. */
  runtimeRoot?: string;
}

/**
 * Connection-owner service contract registered as `ctx.remoteHub`.
 *
 * The registry surface (`addTarget`/`removeTarget`/`listTargets`/`getTarget`)
 * is designed so a persistent store can back it without changing consumers.
 * Implementations own the connection lifecycle and emit the `remote/*` events
 * declared above.
 */
export abstract class RemoteHub extends Service {
  constructor(ctx: Context) {
    super(ctx, 'remoteHub');
  }

  /** Register a target; returns its id. Throws on id collision. */
  abstract addTarget(config: RemoteTarget): string;

  /** Unregister a target, closing its connection first if needed. */
  abstract removeTarget(id: string): Promise<void>;

  /** List all registered targets with their current status. */
  abstract listTargets(): RemoteTargetInfo[];

  /** Look up a target's registration. */
  abstract getTarget(id: string): RemoteTarget | undefined;

  /** The live transport for a target, if currently connected. */
  abstract get(id: string): RemoteTransport | undefined;

  /** Current lifecycle state of a target (`disconnected` when unknown). */
  abstract status(id: string): ConnectionStatus;

  /** Absolute runtime-root path on the remote host, once connected. */
  abstract runtimeRoot(id: string): string | undefined;

  /**
   * Connect to a target, idempotently.
   *
   * An already-connected target returns its existing transport; concurrent
   * calls while a connection is being established share the same promise.
   * On success the per-session runtime root (`~/.cache/dsh-remote/<hex>`)
   * is created on the remote host; failure there fails the connection and
   * cleans up the transport.
   */
  abstract connect(id: string): Promise<RemoteTransport>;

  /** Close a target's connection (no-op when already disconnected). */
  abstract disconnect(id: string): Promise<void>;
}

export namespace RemoteHub {
  /** Service-level options; per-target hooks live on {@link RemoteTarget}. */
  export interface Config {
    /** Host-key verification applied to every connection. */
    hostVerifier?: (fingerprint: string, hostKey: Buffer) => boolean | Promise<boolean>;
    /**
     * Base directory (relative to the remote `$HOME`) under which
     * per-session runtime roots are created. Defaults to
     * `.cache/dsh-remote`.
     */
    runtimeRootBase?: string;
  }
}
