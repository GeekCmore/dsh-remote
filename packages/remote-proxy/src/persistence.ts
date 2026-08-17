/**
 * `RemoteSessionPersistence`: the upstream abstract `SessionPersistence`
 * (`@deepseek-ai/dsh-session-persistence`) subclassed as a READ-MOSTLY
 * remote-backed implementation.
 *
 * The remote host is the source of truth for durability:
 * - `list` / `listSnapshots` come from the daemon's session catalog (raw
 *   `session.list` — revisions embed the remote `lastSeq`);
 * - `inspect` / `load` / `readFrom` / `prepare` read seq-paginated history
 *   via a raw `session.history` call on the target's connection — a COLD
 *   read that never attaches a handle and never resumes the remote agent
 *   (the backend serves it from the live log or its own persistence);
 * - `create` / `append` are deliberate NO-OPs: mirrored events already flow
 *   from the remote log, and writing a second local copy would fork the
 *   truth. A `session/flush` listener is registered so the store's `flush()`
 *   checkpoint reports durability participation honestly (the remote host's
 *   own checkpointing owns actual durability).
 *
 * Live sessions: `inspect`/`readFrom` borrow the mirrored store snapshot;
 * `load` rejects while a mirrored turn is open (upstream contract); `prepare`
 * rejects for live ids (resume of an already-live session is a duplicate).
 */
import type { Context } from '@deepseek-ai/cordis';
import {
  Session,
  SessionId,
  SessionPreparation,
  SESSION_FORMAT_VERSION,
  type SessionEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session';
import {
  SessionPersistence,
  SessionPersistenceRevision,
  type SessionInspection,
  type SessionLocation,
  type SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence';
import type { RemoteClient } from '@dsh-remote/client';
import {
  Methods,
  type SessionHistoryResult,
  type SessionListResult,
} from '@dsh-remote/core';
import { appendMirroredEvent, readRemoteHistory, type MirroredWireEvent } from './events.js';

export interface RemoteSessionPersistenceDeps {
  client: RemoteClient;
  targetId: string;
}

export class RemoteSessionPersistence extends SessionPersistence {
  override readonly supportsRawArtifacts = false;
  private readonly client: RemoteClient;
  private readonly targetId: string;

  constructor(ctx: Context, deps: RemoteSessionPersistenceDeps) {
    super(ctx);
    this.client = deps.client;
    this.targetId = deps.targetId;
    // Durability participation: the mirrored log's durable copy lives on the
    // remote host (its own checkpoint policy flushes it), so the local flush
    // barrier has nothing to write but DOES participate.
    ctx.on('session/flush', () => {});
  }

  /** No local per-session artifact exists — artifacts live on the remote host. */
  override locate(_meta: SessionHeader): SessionLocation | undefined {
    return undefined;
  }

  /** No-op: remote sessions are registered by the remote host at creation. */
  override create(_meta: SessionHeader): Promise<void> {
    return Promise.resolve();
  }

  /** No-op: the remote host persists the log; a local copy would fork the truth. */
  override append(_id: SessionId, _events: readonly SessionEvent[]): Promise<void> {
    return Promise.resolve();
  }

  override async prepare(id: SessionId, signal?: AbortSignal): Promise<SessionPreparation> {
    if (this.ctx.sessions.get(id) !== undefined) {
      throw new Error(
        `@dsh-remote/proxy: session "${id}" is live in this process; prepare() serves cold sessions only`,
      );
    }
    const { meta, events } = await this.readCold(id, signal);
    const session = Session.create(id, undefined, meta);
    for (const wire of events) appendMirroredEvent(session, wire);
    return SessionPreparation.create(session);
  }

  override async load(id: SessionId): Promise<SessionInspection> {
    const live = this.ctx.sessions.get(id);
    if (live !== undefined) {
      if (hasOpenTurn(live.events)) {
        throw new Error(
          `@dsh-remote/proxy: session "${id}" has an open live turn; load() serves balanced logs only`,
        );
      }
      return { meta: live.header, events: live.events };
    }
    const { session } = await this.buildDetached(id);
    return { meta: session.header, events: session.events };
  }

  override async inspect(id: SessionId, signal?: AbortSignal): Promise<SessionInspection> {
    const live = this.ctx.sessions.get(id);
    if (live !== undefined) return { meta: live.header, events: live.events };
    const { session } = await this.buildDetached(id, signal);
    return { meta: session.header, events: session.events };
  }

  override async readFrom(
    id: SessionId,
    fromSeq: number,
    signal?: AbortSignal,
  ): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    const live = this.ctx.sessions.get(id);
    if (live !== undefined) {
      return { meta: live.header, events: live.events.filter((e) => e.seq >= fromSeq) as SessionEvent[] };
    }
    const { session } = await this.buildDetached(id, signal);
    return {
      meta: session.header,
      events: session.events.filter((e) => e.seq >= fromSeq) as SessionEvent[],
    };
  }

  override async list(_signal?: AbortSignal): Promise<SessionHeader[]> {
    const summaries = await this.rawList();
    return summaries.map((s) => summaryHeader(s));
  }

  override async listSnapshots(_signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]> {
    const summaries = await this.rawList();
    return summaries.map((s) => ({
      header: summaryHeader(s),
      revision: SessionPersistenceRevision(
        `remote-proxy:${this.targetId}:${s.sessionId}:seq${s.lastSeq}`,
      ),
    }));
  }

  /** Build a validated detached Session from a cold read (no attach, no resume). */
  private async buildDetached(
    id: SessionId,
    signal?: AbortSignal,
  ): Promise<{ session: Session }> {
    const { meta, events } = await this.readCold(id, signal);
    const session = Session.create(id, undefined, meta);
    for (const wire of events) appendMirroredEvent(session, wire);
    return { session };
  }

  /** Cold read: paged `session.history` over the bare connection — no attach, no agent resume. */
  private async readCold(
    id: SessionId,
    _signal?: AbortSignal,
  ): Promise<{ meta: SessionHeader; events: MirroredWireEvent[] }> {
    const conn = await this.client.connection(this.targetId);
    const events = await readRemoteHistory(async (params) => {
      const res = await conn.call<SessionHistoryResult>(Methods.SessionHistory, {
        sessionId: id,
        ...params,
      });
      return {
        entries: res.entries.map((entry) => ({
          seq: entry.seq,
          event: entry.event as unknown as MirroredWireEvent,
        })),
        hasMore: res.hasMore,
      };
    });
    const summaries = await this.rawList();
    const summary = summaries.find((s) => s.sessionId === id);
    return { meta: summaryHeader(summary, id), events };
  }

  private async rawList() {
    const conn = await this.client.connection(this.targetId);
    const result = await conn.call<SessionListResult>(Methods.SessionList);
    return result.sessions;
  }
}

type RawSummary = SessionListResult['sessions'][number];

function summaryHeader(summary: RawSummary | undefined, id?: SessionId): SessionHeader {
  const sessionId = SessionId(summary?.sessionId ?? (id as unknown as string));
  return {
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
    createdAt: typeof summary?.createdAt === 'number' ? summary.createdAt : 0,
    ...(summary?.cwd ? { cwd: summary.cwd } : {}),
  };
}

/** Last turn boundary opens a turn → the log is mid-turn. */
function hasOpenTurn(events: readonly SessionEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const type = events[i]!.type;
    if (type === 'turn/start') return true;
    if (type === 'turn/end') return false;
  }
  return false;
}
