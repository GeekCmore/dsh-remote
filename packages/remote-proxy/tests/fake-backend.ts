/**
 * COPIED from `packages/remote-client/tests/fake-backend.ts` (test-private,
 * not exported — the known twin-copy pattern; dedup is a later chore).
 *
 * In-memory fake of the dsh-remote daemon backend: a mini session broker
 * speaking the FULL core protocol vocabulary over a {@link JsonRpcPeer} wired
 * to in-memory byte pipes. No network, no SSH.
 *
 * v1 semantics (aligned with the reconciled wire protocol):
 * - `hello`/`hello.proof` handshake with real HMAC verification and
 *   backend-assigned client ids; the challenge advertises this fake's
 *   `capabilities` (constructor option; defaults to the full known set);
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
 *
 * v2 additions:
 * - `session.history` (seq-paginated, `beforeSeq`/`maxMessages`, `hasMore`),
 *   `session.compact` (declines while running), `session.fork` (`atSeq` /
 *   `boundary` truncation), `session.prompt` with `content` blocks (echoed
 *   into the `user/message` event data), `catalog.list` (canned catalogs);
 * - approval trio: `raiseApproval()` (test API) notifies attached clients
 *   with `approval.request`; `approval.answer` settles it and broadcasts
 *   `approval.closed` naming the winner;
 * - question trio: `raiseQuestion()` + `question.answer` + `question.closed`;
 * - pending approvals/questions are replayed in the attach result's
 *   `pendingInteractions` (only when the `pending-interactions` capability
 *   is advertised).
 */
import {
  Capabilities,
  JsonRpcPeer,
  Methods,
  Notifications,
  RemoteError,
  createChallenge,
  verifyProof,
  type ApprovalAnswerParams,
  type ApprovalRequestParams,
  type CatalogListParams,
  type ChallengeMessage,
  type ControlChangeReason,
  type HelloMessage,
  type HelloProofParams,
  type PendingInteraction,
  type QuestionAnswerParams,
  type QuestionRequestParams,
  type SessionAttachParams,
  type SessionCompactParams,
  type SessionEventEnvelope,
  type SessionForkParams,
  type SessionHistoryParams,
  type SessionPromptParams,
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
  pendingApprovals: Map<string, ApprovalRequestParams>;
  pendingQuestions: Map<string, QuestionRequestParams>;
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
  private readonly capabilities: Set<string>;
  private readonly sessions = new Map<string, FakeSession>();
  private readonly conns = new Set<ConnState>();
  private sessionCounter = 0;
  private messageCounter = 0;
  private clientCounter = 0;
  private approvalCounter = 0;
  private questionCounter = 0;
  /** Every session.compact call, in order (test assertions). */
  readonly compactCalls: string[] = [];
  /** Every session.fork call: `{source, upto}` (the resolved cut seq). */
  readonly forkCalls: { source: string; upto: number }[] = [];

  constructor(opts: { token: string; capabilities?: string[] }) {
    this.token = opts.token;
    this.capabilities = new Set(opts.capabilities ?? Object.values(Capabilities));
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
      pendingApprovals: new Map(),
      pendingQuestions: new Map(),
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

  /**
   * Raise an approval request on a session (test API): notifies every attached
   * client with `approval.request` and keeps it pending until answered.
   * Returns the request id.
   */
  raiseApproval(req: { sessionId: string; kind: string; summary: string; detail?: unknown }): string {
    const s = this.mustSession(req.sessionId);
    const params: ApprovalRequestParams = {
      requestId: `appr-${++this.approvalCounter}`,
      sessionId: s.sessionId,
      kind: req.kind,
      summary: req.summary,
      ...(req.detail !== undefined ? { detail: req.detail } : {}),
    };
    s.pendingApprovals.set(params.requestId, params);
    for (const conn of this.conns) {
      if (conn.attached.has(s.sessionId)) conn.peer.notify(Methods.ApprovalRequest, params);
    }
    return params.requestId;
  }

  /**
   * Raise a structured question on a session (test API): notifies every
   * attached client with `question.request` and keeps it pending until
   * answered. Returns the question id.
   */
  raiseQuestion(req: {
    sessionId: string;
    summary?: string;
    items: QuestionRequestParams['items'];
  }): string {
    const s = this.mustSession(req.sessionId);
    const params: QuestionRequestParams = {
      questionId: `q-${++this.questionCounter}`,
      sessionId: s.sessionId,
      ...(req.summary !== undefined ? { summary: req.summary } : {}),
      items: req.items,
    };
    s.pendingQuestions.set(params.questionId, params);
    for (const conn of this.conns) {
      if (conn.attached.has(s.sessionId)) conn.peer.notify(Methods.QuestionRequest, params);
    }
    return params.questionId;
  }

  /** Pending approval requests of a session (test assertions). */
  pendingApprovalsOf(sessionId: string): ApprovalRequestParams[] {
    return [...this.mustSession(sessionId).pendingApprovals.values()];
  }

  /** Pending question requests of a session (test assertions). */
  pendingQuestionsOf(sessionId: string): QuestionRequestParams[] {
    return [...this.mustSession(sessionId).pendingQuestions.values()];
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
      const challenge: ChallengeMessage = createChallenge(undefined, [...this.capabilities]);
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
      const p = params as SessionPromptParams;
      const s = this.mustSession(p.sessionId);
      if (!conn.attached.has(s.sessionId)) {
        throw new RemoteError('REMOTE_PROTOCOL_ERROR', `not attached to session: ${s.sessionId}`);
      }
      if (s.holder === null || s.holder !== conn.clientId) {
        throw new RemoteError('REMOTE_SESSION_LOCKED', 'write control required to prompt', {
          data: { ...(s.holder !== null ? { holder: s.holder } : {}) },
        });
      }
      this.emit(s.sessionId, 'user/message', {
        text: p.text,
        ...(p.content !== undefined ? { content: p.content } : {}),
      });
      this.setStatus(s.sessionId, 'running');
      return { messageId: `msg-${++this.messageCounter}` };
    });
    peer.on(Methods.SessionCancel, (params) => {
      const { sessionId } = params as { sessionId: string };
      const s = this.mustSession(sessionId);
      if (s.status === 'running') this.setStatus(sessionId, 'idle');
      return null;
    });
    peer.on(Methods.SessionHistory, (params) => {
      const p = params as SessionHistoryParams;
      const s = this.mustSession(p.sessionId);
      let events =
        p.beforeSeq !== undefined ? s.events.filter((e) => e.seq < (p.beforeSeq as number)) : [...s.events];
      const max = p.maxMessages ?? 50;
      if (events.length > max) events = events.slice(events.length - max);
      return {
        entries: events.map((event) => ({ seq: event.seq, event })),
        hasMore: events.length > 0 && events[0]!.seq > 0,
      };
    });
    peer.on(Methods.SessionCompact, (params) => {
      const p = params as SessionCompactParams;
      const s = this.mustSession(p.sessionId);
      this.compactCalls.push(s.sessionId);
      // The fake declines to compact while a turn is in flight.
      return { compacted: s.status !== 'running' };
    });
    peer.on(Methods.SessionFork, (params) => {
      const p = params as SessionForkParams;
      const s = this.mustSession(p.sessionId);
      const upto = p.atSeq ?? p.boundary ?? s.events.length - 1;
      this.forkCalls.push({ source: s.sessionId, upto });
      const child = this.createSession({
        cwd: s.cwd,
        ...(s.title !== undefined ? { title: s.title } : {}),
      });
      const cs = this.sessions.get(child.sessionId)!;
      cs.events = s.events.slice(0, upto + 1).map((e) => ({ ...e }));
      return { sessionId: child.sessionId };
    });
    peer.on(Methods.ApprovalAnswer, (params) => {
      const p = params as ApprovalAnswerParams;
      for (const s of this.sessions.values()) {
        if (!s.pendingApprovals.delete(p.requestId)) continue;
        for (const other of this.conns) {
          if (other.attached.has(s.sessionId)) {
            other.peer.notify(Notifications.ApprovalClosed, {
              requestId: p.requestId,
              decision: p.decision,
              ...(conn.clientId !== null ? { winner: conn.clientId } : {}),
            });
          }
        }
        return null;
      }
      throw new RemoteError('REMOTE_PROTOCOL_ERROR', `unknown approval request: ${p.requestId}`);
    });
    peer.on(Methods.QuestionAnswer, (params) => {
      const p = params as QuestionAnswerParams;
      for (const s of this.sessions.values()) {
        if (!s.pendingQuestions.delete(p.questionId)) continue;
        for (const other of this.conns) {
          if (other.attached.has(s.sessionId)) {
            other.peer.notify(Notifications.QuestionClosed, {
              questionId: p.questionId,
              answers: p.answers,
              ...(conn.clientId !== null ? { winner: conn.clientId } : {}),
            });
          }
        }
        return null;
      }
      throw new RemoteError('REMOTE_PROTOCOL_ERROR', `unknown question: ${p.questionId}`);
    });
    peer.on(Methods.CatalogList, (params) => {
      const p = params as CatalogListParams;
      if (p.kind === 'models') {
        return {
          kind: 'models',
          providers: [
            {
              provider: 'fake-provider',
              models: [
                { id: 'fake-model-1', name: 'Fake Model 1', current: true, routable: true },
                { id: 'fake-model-2', routable: false },
              ],
            },
          ],
        };
      }
      if (p.kind === 'skills') {
        return { kind: 'skills', skills: [{ name: 'fake-skill', description: 'A fake skill' }] };
      }
      return {
        kind: 'agentPresets',
        agentPresets: [{ id: 'fake-preset', name: 'Fake Preset', isDefault: true }],
      };
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
    const pending = this.pendingInteractions(s);
    return {
      sessionId: s.sessionId,
      holder: s.holder,
      lastSeq: s.events.length - 1,
      ...(pending !== undefined ? { pendingInteractions: pending } : {}),
    };
  }

  /** Outstanding approvals/questions, when the capability is advertised. */
  private pendingInteractions(s: FakeSession): PendingInteraction[] | undefined {
    if (!this.capabilities.has(Capabilities.PendingInteractions)) return undefined;
    const out: PendingInteraction[] = [
      ...[...s.pendingApprovals.values()].map(
        (request): PendingInteraction => ({ kind: 'approval', request }),
      ),
      ...[...s.pendingQuestions.values()].map(
        (request): PendingInteraction => ({ kind: 'question', request }),
      ),
    ];
    return out.length > 0 ? out : undefined;
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
