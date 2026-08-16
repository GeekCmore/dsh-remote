/**
 * In-memory fake of the dsh-remote daemon backend: a mini session broker
 * speaking the core protocol vocabulary (`hello`/`hello.proof` handshake with
 * real HMAC verification and backend-assigned client ids, `session.*`
 * methods, `session.event` / `session.status` / `session.control-changed`
 * notifications) over a {@link JsonRpcPeer} wired to in-memory byte pipes.
 * No network, no SSH.
 *
 * Semantics simulated (aligned with the reconciled wire protocol):
 * - per-session event log with 0-based monotonic seq; events ride the wire in
 *   the single seams shape (`{type, seq, time, data}` inside the envelope);
 *   attach replays `seq > sinceSeq` (notifications precede the attach result
 *   on the wire), then live events; a fresh session reports `lastSeq: -1`;
 * - a single write-control lease per session named by the backend-assigned
 *   client id: non-force write attach against a taken lease fails
 *   REMOTE_SESSION_LOCKED with `{holder, attachedAt}` data; `force` preempts;
 *   release/detach/holder-disconnect free it;
 * - prompt requires the write lease and returns `{messageId}`, appends a
 *   `user/message` event and flips the session to `running`;
 * - `session.create` (core `Methods.SessionCreate`) makes a fresh session.
 */
import {
  JsonRpcPeer,
  Methods,
  Notifications,
  RemoteError,
  createChallenge,
  verifyProof,
  type ChallengeMessage,
  type ControlChangeReason,
  type HelloMessage,
  type HelloProofParams,
  type SessionAttachParams,
  type SessionEventEnvelope,
  type SessionStatus,
  type WireSessionEvent,
} from '@dsh-remote/core';
import type { ExecProcess } from '@dsh-remote/remote';
import { BytePipe } from './byte-pipe.js';

interface FakeSession {
  sessionId: string;
  title?: string;
  cwd: string;
  createdAt: number;
  status: SessionStatus;
  events: WireSessionEvent[];
  holder: string | null;
  holderSince?: string;
}

interface ConnState {
  peer: JsonRpcPeer;
  clientId: string | null;
  attached: Set<string>;
  hello?: HelloMessage;
  toBroker: BytePipe;
  fromBroker: BytePipe;
  closed: boolean;
}

export class FakeBackendBroker {
  private readonly token: string;
  private readonly sessions = new Map<string, FakeSession>();
  private readonly conns = new Set<ConnState>();
  private sessionCounter = 0;
  private messageCounter = 0;
  private clientCounter = 0;

  constructor(opts: { token: string }) {
    this.token = opts.token;
  }

  /** Spawn the broker end of one backend channel; returns the client's ExecProcess. */
  spawn(): ExecProcess {
    const toBroker = new BytePipe();
    const fromBroker = new BytePipe();
    const conn: ConnState = {
      peer: undefined as unknown as JsonRpcPeer,
      clientId: null,
      attached: new Set(),
      toBroker,
      fromBroker,
      closed: false,
    };
    conn.peer = new JsonRpcPeer(
      {
        send: (line) => {
          try {
            fromBroker.push(line);
          } catch {
            // Client side already gone.
          }
        },
      },
      toBroker,
    );
    this.registerHandlers(conn);
    this.conns.add(conn);
    void conn.peer.closed.then(() => this.onConnClosed(conn));
    const stderr = new BytePipe();
    stderr.end();
    let resolveDone!: (v: { code: number | null; signal?: string }) => void;
    const done = new Promise<{ code: number | null; signal?: string }>((resolve) => {
      resolveDone = resolve;
    });
    return {
      stdout: fromBroker,
      stderr,
      write: (data) => {
        try {
          toBroker.push(typeof data === 'string' ? new TextEncoder().encode(data) : data);
        } catch {
          // Broker side already gone.
        }
      },
      endStdin: () => toBroker.end(),
      done,
      kill: async () => {
        this.endConn(conn);
        resolveDone({ code: 0 });
      },
    };
  }

  /** Directly register a session (test setup shortcut, no RPC). */
  createSession(opts: { cwd?: string; title?: string } = {}): { sessionId: string } {
    const sessionId = `s-${++this.sessionCounter}`;
    this.sessions.set(sessionId, {
      sessionId,
      cwd: opts.cwd ?? '/remote/work',
      createdAt: Date.now(),
      status: 'idle',
      events: [],
      holder: null,
      ...(opts.title !== undefined ? { title: opts.title } : {}),
    });
    return { sessionId };
  }

  /** Append an event to a session's log and broadcast it to attached clients. */
  emit(sessionId: string, type: string, data?: unknown): number {
    const s = this.mustSession(sessionId);
    const event: WireSessionEvent = {
      type,
      seq: s.events.length,
      time: Date.now(),
      ...(data !== undefined ? { data } : {}),
    };
    const env: SessionEventEnvelope = { sessionId, event };
    s.events.push(event);
    for (const conn of this.conns) {
      if (conn.attached.has(sessionId)) conn.peer.notify(Notifications.SessionEvent, env);
    }
    return event.seq;
  }

  /** Change a session's lifecycle status and broadcast it. */
  setStatus(sessionId: string, status: SessionStatus): void {
    const s = this.mustSession(sessionId);
    s.status = status;
    for (const conn of this.conns) {
      if (conn.attached.has(sessionId)) {
        conn.peer.notify(Notifications.SessionStatus, { sessionId, status });
      }
    }
  }

  /** Drop every live client connection (network-loss simulation). */
  dropConnections(): void {
    for (const conn of [...this.conns]) this.endConn(conn);
  }

  /** Drop only the oldest live connection (multi-client tests). */
  dropFirstConnection(): void {
    const first = [...this.conns][0];
    if (first) this.endConn(first);
  }

  connectionCount(): number {
    return this.conns.size;
  }

  attachedClients(sessionId: string): number {
    let n = 0;
    for (const conn of this.conns) if (conn.attached.has(sessionId)) n++;
    return n;
  }

  holderOf(sessionId: string): string | null {
    return this.mustSession(sessionId).holder;
  }

  statusOf(sessionId: string): SessionStatus {
    return this.mustSession(sessionId).status;
  }

  private mustSession(sessionId: string): FakeSession {
    const s = this.sessions.get(sessionId);
    if (!s) throw new RemoteError('REMOTE_PROTOCOL_ERROR', `unknown session: ${sessionId}`);
    return s;
  }

  private summary(s: FakeSession) {
    return {
      sessionId: s.sessionId,
      cwd: s.cwd,
      status: s.status,
      attachedClients: this.attachedClients(s.sessionId),
      lastSeq: s.events.length - 1,
      controller: s.holder,
      ...(s.title !== undefined ? { title: s.title } : {}),
      createdAt: s.createdAt,
    };
  }

  private broadcastControl(s: FakeSession, holder: string | null, reason: ControlChangeReason): void {
    for (const conn of this.conns) {
      if (conn.attached.has(s.sessionId)) {
        conn.peer.notify(Notifications.SessionControlChanged, {
          sessionId: s.sessionId,
          holder,
          reason,
        });
      }
    }
  }

  private endConn(conn: ConnState): void {
    if (conn.closed) return;
    conn.closed = true;
    conn.toBroker.end();
    conn.fromBroker.end();
    this.onConnClosed(conn);
  }

  private onConnClosed(conn: ConnState): void {
    if (!this.conns.delete(conn)) return;
    for (const sessionId of conn.attached) {
      const s = this.sessions.get(sessionId);
      if (s && s.holder !== null && s.holder === conn.clientId) {
        s.holder = null;
        this.broadcastControl(s, null, 'disconnected');
      }
    }
    conn.attached.clear();
  }

  private registerHandlers(conn: ConnState): void {
    const peer = conn.peer;
    peer.on(Methods.Hello, (params) => {
      conn.hello = params as HelloMessage;
      const challenge: ChallengeMessage = createChallenge();
      return challenge;
    });
    peer.on(Methods.HelloProof, (params) => {
      const p = params as HelloProofParams;
      if (!conn.hello || !verifyProof(this.token, p.clientNonce, p.serverNonce, p.hello, p.proof)) {
        throw new RemoteError('REMOTE_AUTH_FAILED', 'invalid handshake proof');
      }
      // Client identity is backend-assigned here — never sent by the client.
      conn.clientId = `fake-client-${++this.clientCounter}`;
      return { authenticated: true, clientId: conn.clientId };
    });
    peer.on(Methods.SessionList, () => ({
      sessions: [...this.sessions.values()].map((s) => this.summary(s)),
    }));
    peer.on(Methods.SessionCreate, (params) => {
      const p = (params ?? {}) as { cwd?: string; title?: string };
      return this.createSession(p);
    });
    peer.on(Methods.SessionAttach, (params) => this.attach(conn, params));
    peer.on(Methods.SessionDetach, (params) => {
      const { sessionId } = params as { sessionId: string };
      this.detachConn(conn, sessionId, 'released');
      return null;
    });
    peer.on(Methods.SessionControlRelease, (params) => {
      const { sessionId } = params as { sessionId: string };
      const s = this.mustSession(sessionId);
      if (s.holder !== null && s.holder === conn.clientId) {
        s.holder = null;
        this.broadcastControl(s, null, 'released');
      }
      return null;
    });
    peer.on(Methods.SessionPrompt, (params) => {
      const p = params as { sessionId: string; text: string };
      const s = this.mustSession(p.sessionId);
      if (!conn.attached.has(s.sessionId)) {
        throw new RemoteError('REMOTE_PROTOCOL_ERROR', `not attached to session: ${s.sessionId}`);
      }
      if (s.holder === null || s.holder !== conn.clientId) {
        throw new RemoteError('REMOTE_SESSION_LOCKED', 'write control required to prompt', {
          data: { ...(s.holder !== null ? { holder: s.holder } : {}) },
        });
      }
      this.emit(s.sessionId, 'user/message', { text: p.text });
      this.setStatus(s.sessionId, 'running');
      return { messageId: `msg-${++this.messageCounter}` };
    });
    peer.on(Methods.SessionCancel, (params) => {
      const { sessionId } = params as { sessionId: string };
      const s = this.mustSession(sessionId);
      if (s.status === 'running') this.setStatus(sessionId, 'idle');
      return null;
    });
  }

  private attach(conn: ConnState, params: unknown) {
    const p = params as SessionAttachParams;
    const s = this.mustSession(p.sessionId);
    conn.clientId ??= `fake-client-${++this.clientCounter}`;
    const prev = s.holder;
    if (p.mode === 'write' && prev !== conn.clientId) {
      if (prev !== null && !p.force) {
        throw new RemoteError('REMOTE_SESSION_LOCKED', `session "${s.sessionId}" is controlled by another client`, {
          data: { holder: prev, ...(s.holderSince !== undefined ? { attachedAt: s.holderSince } : {}) },
        });
      }
      conn.attached.add(s.sessionId);
      s.holder = conn.clientId;
      s.holderSince = new Date().toISOString();
      this.broadcastControl(s, conn.clientId, prev !== null ? 'preempted' : 'acquired');
    } else {
      conn.attached.add(s.sessionId);
    }
    // Replay BEFORE the result: notifications precede the response on the wire.
    if (p.sinceSeq !== undefined) {
      for (const event of s.events) {
        if (event.seq > p.sinceSeq) {
          conn.peer.notify(Notifications.SessionEvent, { sessionId: s.sessionId, event });
        }
      }
    }
    return { sessionId: s.sessionId, holder: s.holder, lastSeq: s.events.length - 1 };
  }

  private detachConn(conn: ConnState, sessionId: string, holderReason: ControlChangeReason): void {
    if (!conn.attached.delete(sessionId)) return;
    const s = this.sessions.get(sessionId);
    if (s && s.holder !== null && s.holder === conn.clientId) {
      s.holder = null;
      this.broadcastControl(s, null, holderReason);
    }
  }
}
