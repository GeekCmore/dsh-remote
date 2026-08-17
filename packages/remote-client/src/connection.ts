/**
 * One daemon channel to a target: the `dsh-remote-backend serve` exec process
 * spawned through the target's transport (resolved via a structural
 * {@link TargetConnector}), the {@link JsonRpcPeer} riding its stdin/stdout,
 * the pairing-token handshake, and the reconnect loop that re-attaches
 * subscribers from their seq cursors.
 *
 * Reconnect policy: when the byte stream drops, the channel retries with
 * exponential backoff (`reconnectInitialDelayMs` doubling up to
 * `reconnectMaxDelayMs`, at most `reconnectMaxAttempts` times — unlimited by
 * default). While the channel is down, {@link call} fails fast with
 * REMOTE_CONN_LOST; subscribers stay registered and are re-attached with
 * `sinceSeq = <their cursor>` after the next successful open, so replayed
 * events resume exactly where delivery stopped (duplicates are dropped by the
 * subscriber).
 *
 * Capabilities: the handshake advertises this client's feature set
 * (`config.capabilities`, the `hello` message) and records the set the
 * backend answers with ({@link capabilities}); feature calls against a
 * backend that does not advertise the matching bit fail fast locally with
 * REMOTE_CAPABILITY_UNSUPPORTED instead of making a doomed round trip.
 */
import {
  Capabilities,
  JsonRpcPeer,
  Methods,
  Notifications,
  RemoteError,
  computeProof,
  createHello,
  toRemoteError,
  type ChallengeMessage,
  type ControlChangeReason,
  type HelloProofParams,
  type HelloProofResult,
  type SessionAttachParams,
  type SessionAttachResult,
  type SessionControlChangedNotification,
  type SessionEventEnvelope,
  type SessionStatus,
  type SessionStatusNotification,
} from '@dsh-remote/core';
import type { ExecProcess } from '@dsh-remote/remote';
import type { TargetConnector } from './connector.js';

/** A per-session subscriber (one attached handle) of a {@link TargetConnection}. */
export interface SessionSubscriber {
  readonly sessionId: string;
  /** Params for the re-attach sent after a reconnect (mode + seq cursor). */
  reattachRequest(): SessionAttachParams;
  handleEvent(env: SessionEventEnvelope): void;
  handleStatus(status: SessionStatus): void;
  handleControl(holder: string | null, reason: ControlChangeReason): void;
  /**
   * The post-reconnect re-attach succeeded; `result` carries the session head
   * seq and any `pendingInteractions` still outstanding (to be replayed).
   */
  onReattached?(result: SessionAttachResult): void;
  /** The post-reconnect re-attach failed; tear down locally. */
  onReattachFailed(err: unknown): void;
}

/** Resolved per-connection configuration (see `RemoteClientConfig`). */
export interface TargetConnectionConfig {
  /** Resolve a pairing-token reference to the token itself. */
  resolveToken: (ref: string) => Promise<string>;
  /** Remote command line that starts the daemon backend on stdin/stdout. */
  backendCommand: string;
  reconnectInitialDelayMs: number;
  reconnectMaxDelayMs: number;
  reconnectMaxAttempts: number;
  /** Default JSON-RPC request deadline. */
  requestTimeoutMs: number;
  /** Feature bits advertised in the handshake hello (defaults to the full known set). */
  capabilities: string[];
  /** Called when a session reports status `ended` (for sessions-changed fanout). */
  onSessionEnded?: (sessionId: string) => void;
}

export class TargetConnection {
  private peer?: JsonRpcPeer;
  private proc?: ExecProcess;
  /** Generation counter: stale peer-close callbacks from superseded connections are ignored. */
  private gen = 0;
  private state: 'connected' | 'down' = 'down';
  private attempt?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private backoffMs: number;
  private attempts = 0;
  private disposed = false;
  #clientId = '';
  /** Capability bits the backend advertised in its handshake challenge. */
  #capabilities = new Set<string>();
  private readonly subscribers = new Map<string, Set<SessionSubscriber>>();
  /** Extra notification handlers (approval/monitor/test hooks); re-registered on every peer. */
  private readonly notificationHandlers = new Map<string, Set<(params: unknown) => void>>();

  constructor(
    private readonly connector: TargetConnector,
    readonly targetId: string,
    private readonly config: TargetConnectionConfig,
  ) {
    this.backoffMs = config.reconnectInitialDelayMs;
  }

  /** Backend-assigned id of the current connection's client; changes on every reconnect. */
  get clientId(): string {
    return this.#clientId;
  }

  /**
   * Capability bits the backend advertised in the handshake challenge
   * (empty for backends that predate capability negotiation). Valid once
   * connected; reset on every reconnect.
   */
  get capabilities(): ReadonlySet<string> {
    return this.#capabilities;
  }

  /**
   * Register a handler for a daemon notification outside the session feed
   * (e.g. `approval.request`, `monitor.metrics`). Low-level escape hatch:
   * handlers survive reconnects and are invoked for every notification of
   * `method` arriving on the live channel.
   */
  onDaemonNotification(method: string, handler: (params: unknown) => void): () => void {
    let set = this.notificationHandlers.get(method);
    if (!set) {
      set = new Set();
      this.notificationHandlers.set(method, set);
      // Arm the live peer too; registerNotifications covers future peers.
      this.peer?.onNotification(method, (params) => this.dispatchExtra(method, params));
    }
    set.add(handler);
    return () => {
      set.delete(handler);
      if (set.size === 0) this.notificationHandlers.delete(method);
    };
  }

  get connected(): boolean {
    return this.state === 'connected';
  }

  subscribe(sub: SessionSubscriber): void {
    let set = this.subscribers.get(sub.sessionId);
    if (!set) {
      set = new Set();
      this.subscribers.set(sub.sessionId, set);
    }
    set.add(sub);
  }

  unsubscribe(sub: SessionSubscriber): void {
    const set = this.subscribers.get(sub.sessionId);
    if (!set) return;
    set.delete(sub);
    if (set.size === 0) this.subscribers.delete(sub.sessionId);
  }

  /**
   * Invoke a daemon method. Fails fast with REMOTE_CONN_LOST while the
   * channel is down or reconnecting; in-flight calls reject with
   * REMOTE_CONN_LOST on their own when the byte stream drops.
   */
  call<T = unknown>(method: string, params?: unknown, signal?: AbortSignal): Promise<T> {
    const peer = this.peer;
    if (this.state !== 'connected' || !peer) {
      return Promise.reject(
        new RemoteError('REMOTE_CONN_LOST', `target "${this.targetId}": daemon channel is down`),
      );
    }
    return peer.call<T>(method, params, signal);
  }

  /**
   * Connect (or reconnect) now. Concurrent callers share the in-flight
   * attempt; a pending backoff timer is cancelled in favor of an immediate try.
   */
  ensureConnected(): Promise<void> {
    if (this.disposed) {
      return Promise.reject(
        new RemoteError('REMOTE_CONN_LOST', `target "${this.targetId}": connection is closed`),
      );
    }
    if (this.state === 'connected') return Promise.resolve();
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    return this.attempt ?? this.launchAttempt();
  }

  /** Detach every subscribed session (best effort) and kill the backend process. */
  async close(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.gen++;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const peer = this.peer;
    const proc = this.proc;
    this.state = 'down';
    this.peer = undefined;
    this.proc = undefined;
    this.#clientId = '';
    this.#capabilities = new Set();
    if (peer) {
      await Promise.all(
        [...this.subscribers.keys()].map((sessionId) =>
          peer.call(Methods.SessionDetach, { sessionId }).then(
            () => undefined,
            () => undefined,
          ),
        ),
      );
    }
    await proc?.kill().catch(() => undefined);
    this.subscribers.clear();
  }

  private launchAttempt(): Promise<void> {
    const p = this.runOpen();
    this.attempt = p;
    void p.then(
      () => {
        if (this.attempt === p) this.attempt = undefined;
        this.attempts = 0;
        this.backoffMs = this.config.reconnectInitialDelayMs;
      },
      () => {
        if (this.attempt === p) this.attempt = undefined;
        this.attempts++;
        this.backoffMs = Math.min(this.backoffMs * 2, this.config.reconnectMaxDelayMs);
        this.scheduleReconnect();
      },
    );
    return p;
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.state === 'connected' || this.timer !== undefined) return;
    if (this.attempts >= this.config.reconnectMaxAttempts) return; // gave up; user calls can retry
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.disposed || this.state === 'connected' || this.attempt) return;
      // Rejections are settled by launchAttempt's handlers; nothing to await here.
      void this.launchAttempt().catch(() => undefined);
    }, this.backoffMs);
  }

  private async runOpen(): Promise<void> {
    if (this.disposed) {
      throw new RemoteError('REMOTE_CONN_LOST', `target "${this.targetId}": connection is closed`);
    }
    const gen = this.gen;
    const transport = await this.connector.connect(this.targetId);
    const proc = await transport.exec(this.config.backendCommand);
    // Drain stderr so a chatty backend can never back-pressure the channel.
    void (async () => {
      for await (const chunk of proc.stderr) void chunk;
    })().catch(() => undefined);
    const peer = new JsonRpcPeer(
      { send: (line) => proc.write(line) },
      proc.stdout,
      { requestTimeoutMs: this.config.requestTimeoutMs },
    );
    let clientId: string;
    let capabilities: string[];
    try {
      ({ clientId, capabilities } = await this.handshake(peer));
    } catch (err) {
      await proc.kill().catch(() => undefined);
      throw err;
    }
    if (this.disposed || gen !== this.gen) {
      await proc.kill().catch(() => undefined);
      throw new RemoteError('REMOTE_CONN_LOST', `target "${this.targetId}": connection superseded`);
    }
    this.peer = peer;
    this.proc = proc;
    this.#clientId = clientId;
    this.#capabilities = new Set(capabilities);
    this.registerNotifications(peer);
    void peer.closed.then(() => this.onPeerClosed(gen));
    await this.reattachAll();
    this.state = 'connected';
  }

  /**
   * Pairing-token handshake: hello → challenge → HMAC proof (core auth.ts).
   * Returns the backend-assigned client id — the ONLY client identity on the
   * wire (control leases name this id; nothing is self-chosen) — plus the
   * capability bits the backend advertised in its challenge (empty for
   * pre-negotiation backends).
   */
  private async handshake(peer: JsonRpcPeer): Promise<{ clientId: string; capabilities: string[] }> {
    const ref = this.connector.pairingTokenRef(this.targetId);
    if (!ref) {
      throw new RemoteError(
        'REMOTE_NOT_BOOTSTRAPPED',
        `target "${this.targetId}" has no pairingTokenRef; run the pairing flow first`,
      );
    }
    const hello = createHello(undefined, this.config.capabilities);
    const challenge = await peer.call<ChallengeMessage>(Methods.Hello, hello);
    const token = await this.config
      .resolveToken(ref)
      .catch((err: unknown) => Promise.reject(toRemoteError(err, 'REMOTE_AUTH_FAILED')));
    const proof = computeProof(token, hello.nonce, challenge.nonce, hello);
    const params: HelloProofParams = {
      clientNonce: hello.nonce,
      serverNonce: challenge.nonce,
      hello,
      proof,
    };
    const result = await peer.call<HelloProofResult>(Methods.HelloProof, params);
    // Backends predating capability negotiation omit the field entirely.
    const capabilities = Array.isArray(challenge.capabilities) ? challenge.capabilities : [];
    return { clientId: result.clientId, capabilities };
  }

  /** Re-attach every subscriber from its seq cursor after a (re)connect. */
  private async reattachAll(): Promise<void> {
    for (const subs of [...this.subscribers.values()]) {
      for (const sub of [...subs]) {
        const base = sub.reattachRequest();
        try {
          const result = await this.peerCall<SessionAttachResult>(Methods.SessionAttach, base);
          sub.onReattached?.(result);
        } catch (err) {
          const locked = err instanceof RemoteError && err.code === 'REMOTE_SESSION_LOCKED';
          if (base.mode === 'write' && locked) {
            // Our lease outlived the disconnect and someone else took it (or
            // the backend kept it): degrade to a read attach instead of failing.
            try {
              const result = await this.peerCall<SessionAttachResult>(Methods.SessionAttach, {
                ...base,
                mode: 'read',
                force: false,
              });
              sub.onReattached?.(result);
              sub.handleControl(null, 'disconnected');
              continue;
            } catch (err2) {
              sub.onReattachFailed(err2);
              continue;
            }
          }
          sub.onReattachFailed(err);
        }
      }
    }
  }

  private peerCall<T>(method: string, params?: unknown): Promise<T> {
    const peer = this.peer;
    if (!peer) return Promise.reject(new RemoteError('REMOTE_CONN_LOST', 'channel opening raced closed'));
    return peer.call<T>(method, params);
  }

  private registerNotifications(peer: JsonRpcPeer): void {
    peer.onNotification(Notifications.SessionEvent, (params) => {
      const env = params as SessionEventEnvelope;
      for (const sub of [...(this.subscribers.get(env.sessionId) ?? [])]) sub.handleEvent(env);
    });
    peer.onNotification(Notifications.SessionStatus, (params) => {
      const n = params as SessionStatusNotification;
      if (n.status === 'ended') this.config.onSessionEnded?.(n.sessionId);
      for (const sub of [...(this.subscribers.get(n.sessionId) ?? [])]) sub.handleStatus(n.status);
    });
    peer.onNotification(Notifications.SessionControlChanged, (params) => {
      const n = params as SessionControlChangedNotification;
      for (const sub of [...(this.subscribers.get(n.sessionId) ?? [])]) sub.handleControl(n.holder, n.reason);
    });
    for (const [method] of this.notificationHandlers) {
      peer.onNotification(method, (params) => this.dispatchExtra(method, params));
    }
  }

  private dispatchExtra(method: string, params: unknown): void {
    for (const handler of [...(this.notificationHandlers.get(method) ?? [])]) handler(params);
  }

  private onPeerClosed(gen: number): void {
    if (this.disposed || gen !== this.gen) return;
    this.state = 'down';
    this.peer = undefined;
    this.proc = undefined;
    this.#clientId = '';
    this.#capabilities = new Set();
    this.attempts = 0;
    this.backoffMs = this.config.reconnectInitialDelayMs;
    this.scheduleReconnect();
  }
}

/** The capability bits this client knows about and advertises by default. */
export const CLIENT_CAPABILITIES: readonly string[] = Object.values(Capabilities);
