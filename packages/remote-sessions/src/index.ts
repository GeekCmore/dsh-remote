/**
 * `@dsh-remote/sessions` — service definition for `ctx.remoteSessions`, the
 * daemon-mode session seam of dsh-remote.
 *
 * In daemon mode a complete dsh headless instance runs on the remote Linux
 * host and owns the real agent sessions; the local frontend attaches to them
 * over an SSH-carried JSON-RPC channel with tmux semantics:
 *
 * - attaching never disturbs the remote session — it only subscribes this
 *   client to the event stream (read) and optionally takes the write-control
 *   lease (write);
 * - detaching (or this process exiting) never disturbs the remote session
 *   either — the agent keeps running and can be re-attached later;
 * - attach is idempotent and re-entrant: attaching the same session twice
 *   yields the same handle, and a client recovering from a dropped channel
 *   re-attaches with its {@link RemoteAgentHandle.lastSeq} cursor so the
 *   backend replays exactly the events that were missed.
 *
 * The handle/summary/option vocabulary is DECLARED in `@dsh-remote/client`
 * (pure TypeScript, cordis-free, single source of truth) and re-exported
 * here; this package adds only the cordis pieces: the `Context`/`Events`
 * augmentation and the abstract {@link RemoteSessions} Service. The
 * cordis-free client implementation lives in `@dsh-remote/client`; the cordis
 * adapter in `@dsh-remote/remote-daemon`.
 */

import { Context, Service } from '@deepseek-ai/cordis';
import type { RemoteError } from '@dsh-remote/core';
import type {
  AttachOptions,
  CreateRemoteSessionOptions,
  RemoteAgentHandle,
  RemoteSessionSummary,
} from '@dsh-remote/client';

export type { ControlChangeReason } from '@dsh-remote/core';
export type {
  AgentPresetSummary,
  ApprovalRequestParams,
  AttachOptions,
  CatalogKind,
  CatalogListResult,
  CatalogModel,
  CreateRemoteSessionOptions,
  ForkOptions,
  HistoryEntry,
  HistoryOptions,
  HistoryPage,
  ModelProviderGroup,
  PendingInteraction,
  PromptContentBlock,
  PromptInput,
  QuestionAnswers,
  QuestionItem,
  QuestionOption,
  QuestionRequestParams,
  RemoteAgentHandle,
  RemoteAgentStatus,
  RemoteAttachMode,
  RemoteSessionState,
  RemoteSessionSummary,
  SkillSummary,
} from '@dsh-remote/client';

declare module '@deepseek-ai/cordis' {
  interface Context {
    remoteSessions: RemoteSessions;
  }

  interface Events {
    /**
     * The session set of a target changed: a session was created, ended, or
     * its attach/control state moved. Listeners typically re-run
     * {@link RemoteSessions.list}.
     * @mode emit
     */
    'remote/sessions-changed'(targetId: string): void;
  }
}

/**
 * Abstract remote-sessions provider, registered as `ctx.remoteSessions`.
 *
 * Implementations own the per-target backend channels and their reconnection;
 * consumers only see handles and summaries.
 */
export abstract class RemoteSessions extends Service {
  constructor(ctx: Context) {
    super(ctx, 'remoteSessions');
  }

  /** List the sessions a target's daemon knows about. */
  abstract list(targetId: string): Promise<RemoteSessionSummary[]>;

  /**
   * Attach to an existing session, idempotently: re-attaching a session this
   * service already serves yields the same handle (escalating its mode when a
   * write attach is requested on a read handle).
   *
   * @throws {@link RemoteError} `REMOTE_SESSION_LOCKED` when `mode: 'write'`
   *   is requested while another client holds the lease and `force` is not
   *   set; the error's `data` carries the holder when known.
   */
  abstract attach(targetId: string, sessionId: string, opts?: AttachOptions): Promise<RemoteAgentHandle>;

  /**
   * Create a new session on the target's daemon and attach to it. The fresh
   * handle starts in `mode: 'write'` (the creator presumably drives it).
   */
  abstract create(targetId: string, opts?: CreateRemoteSessionOptions): Promise<RemoteAgentHandle>;

  /**
   * Detach every handle this service serves — for one target, or across all
   * targets when `targetId` is omitted. Never affects the remote sessions.
   */
  abstract detachAll(targetId?: string): Promise<void>;
}

export default RemoteSessions;
