/**
 * SessionBroker: the daemon-side session proxy. It fronts the host's
 * `ctx.sessions` / `ctx.agents` (narrowed to the structural interfaces in
 * host.ts) for any number of attached frontend connections, providing:
 *
 * - session.list over live + cold sessions, with status/attached/controller;
 * - session.attach with replay-from-sinceSeq followed by a live
 *   `session.event` notification feed (envelopes carry the upstream seq);
 * - session.prompt/cancel/fork gated on the write-control lease;
 * - the control lease itself: one writer per session, force-preemption,
 *   voluntary release, and automatic release on connection loss. Every
 *   change is broadcast as `session.control-changed` to all clients
 *   attached to that session.
 *
 * Leases are process-local (a `Map`) and deliberately NOT persisted: a
 * backend restart drops all control, and the first writer to attach wins
 * afterwards. This keeps crash recovery simple — a stale on-disk lease would
 * otherwise lock every session until it expired.
 */
import {
  Capabilities,
  Notifications,
  RemoteError,
  type AttachMode,
  type PendingInteraction,
  type PromptContentBlock,
  type SessionAttachParams,
  type SessionAttachResult,
  type SessionCompactResult,
  type SessionCreateParams,
  type SessionCreateResult,
  type SessionEventEnvelope,
  type SessionHistoryEntry,
  type SessionHistoryParams,
  type SessionHistoryResult,
  type SessionLockedErrorData,
  type SessionStatus,
  type SessionSummary,
  type WireSessionEvent,
} from '@dsh-remote/core';
import type { SessionEvent } from '@dsh-remote/seams';
import { randomBytes } from 'node:crypto';
import type {
  AgentHostAccess,
  AttachmentsHostAccess,
  CompactionHostAccess,
  HostSession,
  PersistenceHostAccess,
  SessionHostAccess,
} from './host.js';

/** Optional v2 subsystems a SessionBroker may be backed by. */
export interface SessionBrokerExtras {
  /** Cold-session history reads (`session.history`, `history` capability). */
  persistence?: PersistenceHostAccess;
  /** Context compaction (`session.compact`, `compact` capability). */
  compaction?: CompactionHostAccess;
  /** Image prompt blocks (`prompt-blocks` capability). */
  attachments?: AttachmentsHostAccess;
}

/** Options a caller may pass alongside `session.attach` params. */
export interface AttachExtras {
  /**
   * Outstanding interactions on the session, collected by the server from the
   * approval/question bridges when the `pending-interactions` capability is
   * active. Included in the attach result only when non-empty.
   */
  pendingInteractions?: PendingInteraction[];
}

/** Default page size for `session.history` (callers may raise it up to the clamp). */
const HISTORY_DEFAULT_MAX = 200;
/** Hard clamp on `session.history` page size. */
const HISTORY_MAX = 1000;

/** One authenticated frontend connection the broker serves. */
export interface BrokerConnection {
  /** Backend-assigned client id (from the handshake). */
  readonly clientId: string;
  /** Push a notification to this client. */
  notify(method: string, params: unknown): void;
}

interface Attachment {
  readonly sessionId: string;
  readonly unsubscribe: () => void;
}

interface Lease {
  readonly holderId: string;
  readonly attachedAt: string;
}

export class SessionBroker {
  #sessions: SessionHostAccess;
  #agents: AgentHostAccess;
  #persistence?: PersistenceHostAccess;
  #compaction?: CompactionHostAccess;
  #attachments?: AttachmentsHostAccess;
  #connections = new Map<string, BrokerConnection>();
  /** sessionId → attached client ids. */
  #attached = new Map<string, Set<string>>();
  /** clientId → its attachments. */
  #attachmentsByClient = new Map<string, Map<string, Attachment>>();
  /** sessionId → write-control lease (process-local; see module doc). */
  #leases = new Map<string, Lease>();
  /** Sessions with an approval request currently pending. */
  #waitingApproval = new Set<string>();
  #unsubscribeHost: (() => void)[] = [];

  constructor(sessions: SessionHostAccess, agents: AgentHostAccess, extras: SessionBrokerExtras = {}) {
    this.#sessions = sessions;
    this.#agents = agents;
    this.#persistence = extras.persistence;
    this.#compaction = extras.compaction;
    this.#attachments = extras.attachments;
    if (agents.onStatus) {
      this.#unsubscribeHost.push(
        agents.onStatus((agent, status) => {
          this.#toAttached(agent.id, Notifications.SessionStatus, {
            sessionId: agent.id,
            status,
          });
        }),
      );
    }
    if (sessions.onSessionDisposed) {
      this.#unsubscribeHost.push(
        sessions.onSessionDisposed((session) => {
          this.#toAttached(session.id, Notifications.SessionStatus, {
            sessionId: session.id,
            status: 'ended',
          });
        }),
      );
    }
  }

  /** Release host subscriptions (plugin unload). */
  dispose(): void {
    for (const unsub of this.#unsubscribeHost.splice(0)) unsub();
  }

  /**
   * Capability bits this broker can honor, derived from the optional
   * subsystems it was given. `fork-at-seq` is always advertised: the
   * SessionHostAccess contract requires fork to accept `atSeq`.
   */
  get capabilities(): string[] {
    const caps: string[] = [Capabilities.ForkAtSeq];
    if (this.#persistence) caps.push(Capabilities.History);
    if (this.#compaction) caps.push(Capabilities.Compact);
    if (this.#attachments) caps.push(Capabilities.PromptBlocks);
    return caps;
  }

  /** Register an authenticated connection. */
  connect(conn: BrokerConnection): void {
    this.#connections.set(conn.clientId, conn);
  }

  /**
   * Drop a connection: remove every attach subscription it held and release
   * every lease it owned (broadcast with reason "disconnected").
   */
  disconnect(clientId: string): void {
    const mine = this.#attachmentsByClient.get(clientId);
    if (mine) {
      for (const sessionId of [...mine.keys()]) this.#dropAttachment(clientId, sessionId);
    }
    this.#connections.delete(clientId);
    for (const [sessionId, lease] of [...this.#leases]) {
      if (lease.holderId === clientId) {
        this.#leases.delete(sessionId);
        this.#broadcastControl(sessionId, null, 'disconnected');
      }
    }
  }

  /**
   * `session.list`: live sessions plus cold ones from the persistence index.
   * Async because the cold half may be backed by an async persistence store
   * (upstream `SessionPersistence.list()` returns a promise).
   */
  async list(): Promise<SessionSummary[]> {
    const out: SessionSummary[] = [];
    const liveIds = new Set<string>();
    for (const session of this.#sessions.list()) {
      liveIds.add(session.id);
      out.push({
        sessionId: session.id,
        cwd: session.header.cwd ?? '',
        status: this.#statusOf(session),
        attachedClients: this.#attached.get(session.id)?.size ?? 0,
        lastSeq: session.seq - 1,
        controller: this.#leases.get(session.id)?.holderId ?? null,
        createdAt: session.header.createdAt,
      });
    }
    for (const cold of (await this.#sessions.listCold?.()) ?? []) {
      if (liveIds.has(cold.id)) continue;
      out.push({
        sessionId: cold.id,
        cwd: cold.cwd ?? '',
        status: 'ended',
        attachedClients: 0,
        lastSeq: cold.lastSeq ?? -1,
        controller: null,
      });
    }
    return out;
  }

  /**
   * `session.attach`. Read attaches always succeed. Write attaches take the
   * control lease: granted when free, REMOTE_SESSION_LOCKED when held (with
   * `{holder, attachedAt}` details), preempted when `force` is set — the
   * previous holder stays attached read-only and everyone sees
   * `session.control-changed {reason: 'preempted'}`.
   *
   * Replay: events after `sinceSeq` (inclusive-exclusive: strictly greater)
   * are sent first, then the live feed. With `sinceSeq` omitted the client
   * tails from "now". Live events arriving during replay are buffered and
   * de-duplicated by seq.
   */
  attach(clientId: string, params: SessionAttachParams, extras: AttachExtras = {}): SessionAttachResult {
    const conn = this.#requireConnection(clientId);
    const session = this.#sessions.get(params.sessionId);
    if (!session) {
      throw new RemoteError('REMOTE_PROTOCOL_ERROR', `unknown session "${params.sessionId}"`);
    }
    const sessionId = session.id;
    let liveBuffer: SessionEvent[] | null = [];
    const forward = (event: SessionEvent) => {
      // The event crosses verbatim (seams shape is the single wire shape);
      // the envelope only adds the routing key.
      const envelope: SessionEventEnvelope = { sessionId, event };
      conn.notify(Notifications.SessionEvent, envelope);
    };
    const unsubscribe = this.#sessions.onSessionEvent((changed, event) => {
      if (changed.id !== sessionId) return;
      if (liveBuffer) liveBuffer.push(event);
      else forward(event);
    });
    try {
      // Re-read after subscribing: the snapshot must be at least as fresh as
      // anything the buffer can hold.
      const current = this.#sessions.get(sessionId) ?? session;
      const sinceSeq = params.sinceSeq;
      let watermark = sinceSeq === undefined ? current.seq - 1 : sinceSeq;
      if (sinceSeq !== undefined) {
        for (const event of current.events) {
          if (event.seq > sinceSeq) forward(event);
        }
      }
      for (const event of liveBuffer) {
        if (event.seq > watermark) forward(event);
        if (event.seq > watermark) watermark = event.seq;
      }
      liveBuffer = null;
    } catch (err) {
      unsubscribe();
      throw err;
    }

    // Track the attachment BEFORE taking the lease so the acquiring client
    // also receives its own `session.control-changed {reason: 'acquired'}`.
    // A failed acquisition (locked, no force) rolls the attachment back.
    this.#trackAttachment(clientId, sessionId, unsubscribe);
    if (params.mode === 'write') {
      try {
        this.#acquireLease(conn, sessionId, params.force === true);
      } catch (err) {
        this.#dropAttachment(clientId, sessionId);
        throw err;
      }
    }
    return {
      sessionId,
      holder: this.#leases.get(sessionId)?.holderId ?? null,
      lastSeq: session.seq - 1,
      // Absent when nothing is pending or the capability is inactive.
      ...(extras.pendingInteractions !== undefined && extras.pendingInteractions.length > 0
        ? { pendingInteractions: extras.pendingInteractions }
        : {}),
    };
  }

  /** `session.detach`: stop the event feed; a holding writer releases control. */
  detach(clientId: string, sessionId: string): void {
    // Release the lease BEFORE dropping the attachment so the departing
    // holder still receives its own `released` broadcast.
    const lease = this.#leases.get(sessionId);
    if (lease?.holderId === clientId) {
      this.#leases.delete(sessionId);
      this.#broadcastControl(sessionId, null, 'released');
    }
    this.#dropAttachment(clientId, sessionId);
  }

  /**
   * `session.create`: mint a fresh session AND its live agent on the host
   * (when supported). Routed through `AgentHostAccess.create` (upstream
   * `AgentRegistry.create`), never `SessionStore.create`: a bare session has
   * no agent and can never be prompted, and upstream offers no way to attach
   * an agent to an existing session id afterwards. The returned sessionId is
   * the new agent's id (session and agent share one id upstream).
   */
  async create(clientId: string, params: SessionCreateParams): Promise<SessionCreateResult> {
    this.#requireConnection(clientId);
    if (!this.#agents.create) {
      throw new RemoteError(
        'REMOTE_PROTOCOL_ERROR',
        'this host does not support session creation',
      );
    }
    const agent = await this.#agents.create({
      ...(params.cwd !== undefined ? { cwd: params.cwd } : {}),
      ...(params.title !== undefined ? { title: params.title } : {}),
    });
    return { sessionId: agent.id };
  }

  /**
   * `session.prompt`: queue a follow-up turn; write-control holders only.
   * With no `content` blocks the message is the byte-identical legacy shape
   * `content: [{ type: 'text', text }]`; with blocks, images are saved via
   * the attachments host and referenced from the assembled message.
   */
  async prompt(
    clientId: string,
    sessionId: string,
    text: string,
    content?: PromptContentBlock[],
  ): Promise<{ messageId: string }> {
    this.#requireHolder(clientId, sessionId);
    const agent = this.#agents.get(sessionId);
    if (!agent) {
      throw new RemoteError('REMOTE_PROTOCOL_ERROR', `no live agent for session "${sessionId}"`);
    }
    let blocks: unknown[];
    if (content === undefined) {
      blocks = [{ type: 'text', text }];
    } else {
      blocks = [];
      for (const block of content) {
        if (block.type === 'text') {
          blocks.push({ type: 'text', text: block.text });
          continue;
        }
        if (!this.#attachments) {
          throw new RemoteError(
            'REMOTE_CAPABILITY_UNSUPPORTED',
            'this backend cannot accept image prompt blocks',
          );
        }
        const attachment = await this.#attachments.saveImage({
          data: Buffer.from(block.data, 'base64'),
          mediaType: block.mediaType,
          ...(block.name !== undefined ? { name: block.name } : {}),
        });
        blocks.push({
          type: 'image',
          mediaType: block.mediaType,
          ...(block.name !== undefined ? { name: block.name } : {}),
          attachment,
        });
      }
    }
    const messageId = `remote-${randomBytes(8).toString('hex')}`;
    agent.followup({
      id: messageId,
      role: 'user',
      content: blocks,
      source: { kind: 'user' },
    });
    return { messageId };
  }

  /** `session.cancel`: abort the active turn; write-control holders only. */
  cancel(clientId: string, sessionId: string): void {
    this.#requireHolder(clientId, sessionId);
    const agent = this.#agents.get(sessionId);
    if (!agent) {
      throw new RemoteError('REMOTE_PROTOCOL_ERROR', `no live agent for session "${sessionId}"`);
    }
    agent.cancel();
  }

  /** `session.fork`: fork at an optional event boundary; write-control only. */
  fork(clientId: string, sessionId: string, boundary?: number, atSeq?: number): { sessionId: string } {
    this.#requireHolder(clientId, sessionId);
    let child: HostSession;
    try {
      child = this.#sessions.fork(sessionId, boundary, atSeq);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new RemoteError('REMOTE_PROTOCOL_ERROR', `fork failed: ${message}`, { cause: err });
    }
    return { sessionId: child.id };
  }

  /**
   * `session.history`: seq-paginated history WITHOUT resuming an agent. Live
   * sessions are served from their in-memory log; cold sessions go through
   * the persistence host (absent → REMOTE_CAPABILITY_UNSUPPORTED). Entries
   * come back ascending by seq; `beforeSeq` is an exclusive upper bound and
   * `hasMore` is true when older events remain before the first entry.
   */
  async history(params: SessionHistoryParams): Promise<SessionHistoryResult> {
    const live = this.#sessions.get(params.sessionId);
    let events: readonly SessionEvent[];
    if (live) {
      events = live.events;
    } else {
      if (!this.#persistence) {
        throw new RemoteError(
          'REMOTE_CAPABILITY_UNSUPPORTED',
          'this backend cannot read cold session history',
        );
      }
      const info = await this.#persistence.inspect(params.sessionId);
      if (!info) {
        throw new RemoteError('REMOTE_PROTOCOL_ERROR', `unknown session "${params.sessionId}"`);
      }
      events = await this.#persistence.readFrom(params.sessionId);
    }
    const limit = Math.min(Math.max(1, params.maxMessages ?? HISTORY_DEFAULT_MAX), HISTORY_MAX);
    const eligible =
      params.beforeSeq === undefined ? events : events.filter((event) => event.seq < params.beforeSeq!);
    const start = Math.max(0, eligible.length - limit);
    const entries: SessionHistoryEntry[] = eligible.slice(start).map((event) => ({
      seq: event.seq,
      event: event as unknown as WireSessionEvent,
    }));
    return { entries, hasMore: start > 0 };
  }

  /**
   * `session.compact`: compact the live agent's context in place. Requires
   * write control and a live, IDLE agent — a mid-turn or waiting-approval
   * session fails with REMOTE_ABORTED (the operation is refused, not queued;
   * the caller retries when the session goes idle).
   */
  async compact(clientId: string, sessionId: string): Promise<SessionCompactResult> {
    if (!this.#compaction) {
      throw new RemoteError(
        'REMOTE_CAPABILITY_UNSUPPORTED',
        'this backend has no compaction subsystem',
      );
    }
    this.#requireHolder(clientId, sessionId);
    const agent = this.#agents.get(sessionId);
    if (!agent) {
      throw new RemoteError('REMOTE_PROTOCOL_ERROR', `no live agent for session "${sessionId}"`);
    }
    if (agent.status !== 'idle' || this.#waitingApproval.has(sessionId)) {
      throw new RemoteError(
        'REMOTE_ABORTED',
        `session "${sessionId}" is busy; compact again when the session is idle`,
      );
    }
    await this.#compaction.compactNow(agent);
    return { compacted: true };
  }

  /** `session.control-release`: the holder voluntarily demotes itself. */
  controlRelease(clientId: string, sessionId: string): void {
    const lease = this.#leases.get(sessionId);
    if (lease?.holderId !== clientId) return;
    this.#leases.delete(sessionId);
    this.#broadcastControl(sessionId, null, 'released');
  }

  /** Mark a session as waiting on an approval decision (or back). */
  setWaitingApproval(sessionId: string, waiting: boolean): void {
    if (waiting === this.#waitingApproval.has(sessionId)) return;
    if (waiting) this.#waitingApproval.add(sessionId);
    else this.#waitingApproval.delete(sessionId);
    this.#toAttached(sessionId, Notifications.SessionStatus, {
      sessionId,
      status: waiting ? 'waiting-approval' : this.#statusOf(this.#sessions.get(sessionId)),
    });
  }

  /** All connections currently attached to a session (approval broadcast). */
  attachedTo(sessionId: string): BrokerConnection[] {
    const out: BrokerConnection[] = [];
    for (const clientId of this.#attached.get(sessionId) ?? []) {
      const conn = this.#connections.get(clientId);
      if (conn) out.push(conn);
    }
    return out;
  }

  /** The write-control holder's connection, when it is still attached. */
  writerOf(sessionId: string): BrokerConnection | undefined {
    const holder = this.#leases.get(sessionId)?.holderId;
    return holder === undefined ? undefined : this.#connections.get(holder);
  }

  /** Every live connection (for host requests with no session attribution). */
  allConnections(): BrokerConnection[] {
    return [...this.#connections.values()];
  }

  /** Aggregate numbers for the monitor metrics envelope. */
  stats(): { sessions: number; attachedClients: number } {
    let attachedClients = 0;
    for (const set of this.#attached.values()) attachedClients += set.size;
    return { sessions: this.#sessions.list().length, attachedClients };
  }

  #statusOf(session: HostSession | undefined): SessionStatus {
    if (!session) return 'ended';
    if (this.#waitingApproval.has(session.id)) return 'waiting-approval';
    return this.#agents.get(session.id)?.status ?? 'idle';
  }

  #requireConnection(clientId: string): BrokerConnection {
    const conn = this.#connections.get(clientId);
    if (!conn) {
      throw new RemoteError('REMOTE_PROTOCOL_ERROR', `unknown client "${clientId}"`);
    }
    return conn;
  }

  #requireHolder(clientId: string, sessionId: string): void {
    const lease = this.#leases.get(sessionId);
    if (lease?.holderId === clientId) return;
    const data: SessionLockedErrorData = {
      ...(lease ? { holder: lease.holderId, attachedAt: lease.attachedAt } : {}),
    };
    throw new RemoteError(
      'REMOTE_SESSION_LOCKED',
      lease
        ? `session "${sessionId}" is controlled by ${lease.holderId}`
        : `session "${sessionId}" requires write control (attach with mode "write" first)`,
      { data },
    );
  }

  #acquireLease(conn: BrokerConnection, sessionId: string, force: boolean): void {
    const lease = this.#leases.get(sessionId);
    if (!lease) {
      this.#leases.set(sessionId, { holderId: conn.clientId, attachedAt: new Date().toISOString() });
      this.#broadcastControl(sessionId, conn.clientId, 'acquired');
      return;
    }
    if (lease.holderId === conn.clientId) return;
    if (!force) {
      const data: SessionLockedErrorData = { holder: lease.holderId, attachedAt: lease.attachedAt };
      throw new RemoteError(
        'REMOTE_SESSION_LOCKED',
        `session "${sessionId}" is controlled by ${lease.holderId}`,
        { data },
      );
    }
    this.#leases.set(sessionId, { holderId: conn.clientId, attachedAt: new Date().toISOString() });
    this.#broadcastControl(sessionId, conn.clientId, 'preempted');
  }

  #trackAttachment(clientId: string, sessionId: string, unsubscribe: () => void): void {
    let bySession = this.#attachmentsByClient.get(clientId);
    if (!bySession) {
      bySession = new Map();
      this.#attachmentsByClient.set(clientId, bySession);
    }
    // Re-attach replaces the previous subscription for the same session.
    bySession.get(sessionId)?.unsubscribe();
    bySession.set(sessionId, { sessionId, unsubscribe });
    let set = this.#attached.get(sessionId);
    if (!set) {
      set = new Set();
      this.#attached.set(sessionId, set);
    }
    set.add(clientId);
  }

  #dropAttachment(clientId: string, sessionId: string): void {
    const attachment = this.#attachmentsByClient.get(clientId)?.get(sessionId);
    if (!attachment) return;
    attachment.unsubscribe();
    this.#attachmentsByClient.get(clientId)?.delete(sessionId);
    const set = this.#attached.get(sessionId);
    set?.delete(clientId);
    if (set?.size === 0) this.#attached.delete(sessionId);
  }

  #broadcastControl(
    sessionId: string,
    holder: string | null,
    reason: 'acquired' | 'released' | 'preempted' | 'disconnected',
  ): void {
    this.#toAttached(sessionId, Notifications.SessionControlChanged, { sessionId, holder, reason });
  }

  #toAttached(sessionId: string, method: string, params: unknown): void {
    for (const conn of this.attachedTo(sessionId)) {
      try {
        conn.notify(method, params);
      } catch {
        // Notification delivery is best-effort; a failing client is dropped
        // by its own disconnect path.
      }
    }
  }
}

/** Re-export the wire attach mode for handler signatures. */
export type { AttachMode };
