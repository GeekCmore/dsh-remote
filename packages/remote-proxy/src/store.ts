/**
 * `RemoteSessionStore`: the real upstream `SessionStore`
 * (`@deepseek-ai/dsh-session`) mounted as `ctx.sessions`, with the two
 * synchronous creation verbs overridden because a remote round trip cannot
 * fit their sync signatures:
 *
 * - `create()` — session creation routes through `ctx.agents.create()` (the
 *   upstream creation contract for frontends), which creates the REMOTE
 *   session via the daemon client before mirroring it locally;
 * - `fork()` — forking routes through the async {@link forkRemote} (wired by
 *   the proxy orchestrator), which performs the daemon `session.fork`
 *   (`atSeq` time-travel included) and mirrors the child.
 *
 * Everything else — `prepare`/`enter`/`announce`, `get`/`list`, `flush`, the
 * `session/created|disposed|event|flush` publication hooks — is the genuine
 * upstream behavior, which is exactly why seam-compliant frontends can run
 * unmodified.
 */
import {
  SessionStore,
  type CreateSessionOptions,
  type Session,
  type SessionForkSource,
  type SessionId,
} from '@deepseek-ai/dsh-session';

export class RemoteSessionStore extends SessionStore {
  /**
   * Async remote fork, installed by the proxy orchestrator. Forks the remote
   * session (optionally at a completed-turn boundary `atSeq` — the daemon
   * protocol's rewind/time-travel semantic), mirrors the child into this
   * store, and resolves with the live local session.
   */
  forkRemote?: (
    source: SessionForkSource,
    opts?: { boundary?: number; atSeq?: number },
  ) => Promise<Session>;

  override create(id?: SessionId, options?: CreateSessionOptions): Session {
    void id;
    void options;
    throw new Error(
      '@dsh-remote/proxy: sessions.create() cannot mint a remote session synchronously; ' +
        'create sessions through ctx.agents.create() — the proxy routes creation to the remote daemon',
    );
  }

  override fork(source: SessionForkSource, boundary?: number, childSessionId?: SessionId): Session {
    void source;
    void boundary;
    void childSessionId;
    throw new Error(
      '@dsh-remote/proxy: sessions.fork() cannot perform a remote fork round trip synchronously; ' +
        'use the async sessions.forkRemote(source, { atSeq }) instead',
    );
  }
}
