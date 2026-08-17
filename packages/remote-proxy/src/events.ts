/**
 * Wire-event mirroring helpers: append daemon-protocol session events
 * (`@dsh-remote/core` `WireSessionEvent`) into a REAL upstream
 * `Session` (`@deepseek-ai/dsh-session`) preserving the remote seq exactly.
 *
 * The declared wire type omits surface metadata, but a backend whose host
 * produces genuine seam events serializes the event object verbatim — so
 * `surfaceOp` / `sourceEventSeqs` may ride the wire as own properties and are
 * honored when present. When absent on a surface-eligible type the mirror
 * synthesizes the `surfaceOp: 'append'` intent (the runtime requires a marker;
 * the compiler-level requirement only exists at typed call sites).
 *
 * Seq contract: the local log is kept seq-exact with the remote log
 * (`local seq === remote seq` for every mirrored event). Mirrored sessions
 * therefore never receive local-only appends (the approval/question bridges
 * deliberately do NOT write local audit events — the remote host's own audit
 * pair arrives over the wire).
 */
import {
  isSurfaceEligibleType,
  type Session,
  type SessionEvent,
  type SurfaceIntent,
  type SurfaceOp,
} from '@deepseek-ai/dsh-session';
import type { WireSessionEvent } from '@dsh-remote/core';

/** A wire event plus the surface metadata that may travel with it verbatim. */
export type MirroredWireEvent = WireSessionEvent & {
  surfaceOp?: SurfaceOp;
  sourceEventSeqs?: number[];
};

/** The untyped runtime shape of `Session.append` (wire types are plain strings). */
type LooseAppend = (type: string, data: unknown, intent?: SurfaceIntent) => SessionEvent;

/**
 * Append one wire event to `session`. The event's assigned seq is the local
 * log length — callers MUST uphold the seq-exact contract (check
 * `wire.seq === session.seq` first, as `SessionMirror` does).
 */
export function appendMirroredEvent(session: Session, wire: MirroredWireEvent): SessionEvent {
  const append = session.append as unknown as LooseAppend;
  const data = wire.data ?? {};
  if (isSurfaceEligibleType(wire.type)) {
    return append.call(session, wire.type, data, {
      surfaceOp: wire.surfaceOp ?? 'append',
      ...(wire.sourceEventSeqs !== undefined ? { sourceEventSeqs: [...wire.sourceEventSeqs] } : {}),
    });
  }
  return append.call(session, wire.type, data);
}

/** One seq-paginated history read (handle.history or a raw connection call). */
export type HistoryFetcher = (params: {
  beforeSeq?: number;
  maxMessages?: number;
}) => Promise<{ entries: { seq: number; event: MirroredWireEvent }[]; hasMore: boolean }>;

/**
 * Page a session's remote history backwards until `fromSeq` is covered;
 * return the events with `seq >= fromSeq` in ascending order. Throws when the
 * remote log is not contiguous from `fromSeq` (a mirror could not be
 * seq-exact, so failing fast beats a silently gutted session).
 */
export async function readRemoteHistory(
  fetch: HistoryFetcher,
  fromSeq = 0,
  pageSize = 500,
): Promise<MirroredWireEvent[]> {
  const pages: MirroredWireEvent[][] = [];
  let beforeSeq: number | undefined;
  for (;;) {
    const page = await fetch(
      beforeSeq === undefined ? { maxMessages: pageSize } : { beforeSeq, maxMessages: pageSize },
    );
    pages.unshift(page.entries.map((entry) => entry.event));
    if (!page.hasMore) break;
    const first = page.entries[0];
    if (!first) break;
    if (first.seq <= fromSeq) break;
    beforeSeq = first.seq;
  }
  const all = pages.flat().filter((event) => event.seq >= fromSeq);
  for (let i = 0; i < all.length; i++) {
    const expected = fromSeq + i;
    if (all[i]!.seq !== expected) {
      throw new Error(
        `remote session history is not contiguous: expected seq ${expected}, got ${all[i]!.seq}`,
      );
    }
  }
  return all;
}
