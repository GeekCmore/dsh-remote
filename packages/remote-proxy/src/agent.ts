/**
 * `RemoteAgentFacade`: a fabricated upstream `Agent` (`@deepseek-ai/dsh-agent`
 * interface — a plain object contract, not a class) whose mutating methods
 * route to the daemon client handle and whose durable state (session, inbox)
 * is mirrored from the remote log.
 *
 * Honest-by-construction members:
 * - `session` is the REAL mirrored `Session` (the mirror keeps the local log
 *   seq-exact with the remote one);
 * - `inbox` is a REAL upstream `Inbox` projection: its constructor replays
 *   the mirrored history's `agent/inbox/spliced` events and the mirror feeds
 *   every later mirrored splice through its (TS-private, runtime-public)
 *   `apply`;
 * - `status` tracks the handle's coarse `running`/`idle` stream and every
 *   transition is re-emitted locally as `agent/status`;
 * - `ctx` is a genuine dsh-scope context minted with the facade itself as the
 *   scope key, so `ctx.agent` and scope-filtered dispatch behave upstream.
 *
 * Deliberate degradations (all documented in the package README):
 * - `followup`/`steer`/`inject`/`send` all route to `handle.prompt(text)`:
 *   the wire carries only prompt submission, so steering/inject timing
 *   nuances belong to the remote loop; non-text content blocks are dropped
 *   (wire prompt blocks carry base64 images, upstream `ImageBlock`s carry
 *   attachment refs — no honest mapping);
 * - `cancel` forwards to `handle.cancel()` (fire-and-forget; the interface
 *   returns void);
 * - `agent/inbox/claimed` is never emitted locally: turn ownership of a claim
 *   is a remote-loop fact the durable splice event does not carry.
 */
import type { Context } from '@deepseek-ai/cordis';
import {
  emitAgentEvent,
  Inbox,
  type Agent,
  type AgentCancelCause,
  type AgentOptions,
  type AgentStatus,
  type CancelOptions,
  type InboxTarget,
} from '@deepseek-ai/dsh-agent';
import type { UserMessage } from '@deepseek-ai/dsh-session';
import type { Session } from '@deepseek-ai/dsh-session';
import type { Logger } from '@deepseek-ai/cordis';
import type { RemoteAgentStatus, RemoteClientHandle } from '@dsh-remote/client';

/** The durable `agent/inbox/spliced` payload (merged into SessionEventMap by dsh-agent). */
export interface InboxSplice {
  target: InboxTarget;
  start: number;
  removedCount?: number;
  inserted: UserMessage[];
  outcome?: 'canceled';
}

/** `Inbox.apply` is TS-private but a plain runtime method; the mirror feeds mirrored splices through it. */
interface InboxApply {
  apply(splice: InboxSplice): UserMessage[];
}

export interface RemoteAgentFacadeDeps {
  /** Plugin-level context, used for logging and event dispatch. */
  ctx: Context;
  session: Session;
  handle: RemoteClientHandle;
  options?: AgentOptions;
}

export class RemoteAgentFacade implements Agent {
  readonly options: AgentOptions;
  readonly session: Session;
  readonly inbox: Inbox;
  private readonly pluginCtx: Context;
  private readonly handle: RemoteClientHandle;
  private readonly logger: Logger;
  private statusField: AgentStatus;
  private readonly idleWaiters = new Set<() => void>();
  private maintenance: Promise<unknown> | undefined;
  private maintenanceAbort: AbortController | undefined;
  private warnedNonText = false;
  /** Set once the agent is announced; inbox notifications stay muted before. */
  private announced = false;
  private agentCtx!: Context;

  constructor(deps: RemoteAgentFacadeDeps) {
    this.pluginCtx = deps.ctx;
    this.session = deps.session;
    this.handle = deps.handle;
    this.options = deps.options ?? {};
    this.logger = deps.ctx.logger('dsh-remote/proxy');
    this.statusField = deps.handle.status() === 'running' ? 'running' : 'idle';
    this.inbox = new Inbox(deps.session, {
      inserted: (message) => {
        if (this.announced) emitAgentEvent(this.pluginCtx, this, 'agent/inbox/inserted', { message });
      },
      discarded: (message) => {
        if (this.announced) emitAgentEvent(this.pluginCtx, this, 'agent/inbox/discarded', { message });
      },
      claimed: (message, turn) => {
        if (this.announced) emitAgentEvent(this.pluginCtx, this, 'agent/inbox/claimed', { message, turn });
      },
    });
    deps.handle.onStatus((status) => this.applyRemoteStatus(status));
  }

  get id() {
    return this.session.id;
  }

  get status(): AgentStatus {
    return this.statusField;
  }

  get ctx(): Context {
    return this.agentCtx;
  }

  /** Installed by the mirror right after construction (scope minting needs the facade first). */
  setAgentContext(ctx: Context): void {
    this.agentCtx = ctx;
  }

  /** Unmute inbox notifications (called after `agent/created` was announced). */
  markAnnounced(): void {
    this.announced = true;
  }

  /** Feed one mirrored durable inbox splice into the projection (called by the mirror). */
  feedInboxSplice(splice: InboxSplice): void {
    let removed: UserMessage[];
    try {
      removed = (this.inbox as unknown as InboxApply).apply(splice);
    } catch (err) {
      this.logger.warn(
        `session "${this.id}": mirrored inbox splice rejected by the projection: ${String(err)}`,
      );
      return;
    }
    if (!this.announced) return;
    for (const message of splice.inserted) {
      emitAgentEvent(this.pluginCtx, this, 'agent/inbox/inserted', { message });
    }
    // `outcome: 'canceled'` marks a durable cancellation; other removals are
    // claims, whose owning turn is a remote-loop fact the splice does not
    // carry — `agent/inbox/claimed` is deliberately not synthesized.
    if (splice.outcome === 'canceled') {
      for (const message of removed) {
        emitAgentEvent(this.pluginCtx, this, 'agent/inbox/discarded', { message });
      }
    }
  }

  cancel(_cause: AgentCancelCause, _options?: CancelOptions): void {
    this.maintenanceAbort?.abort();
    void this.handle.cancel().catch((err) => {
      this.logger.warn(`session "${this.id}": remote cancel failed: ${String(err)}`);
    });
  }

  whenIdle(): Promise<void> {
    if (this.statusField === 'idle' && this.maintenance === undefined) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.statusField !== 'idle' || this.maintenance !== undefined) {
      throw new Error(
        `session "${this.id}": runMaintenance requires the idle phase (turn-driving or another task owns the agent)`,
      );
    }
    this.maintenanceAbort = new AbortController();
    const signal = this.maintenanceAbort.signal;
    const promise = Promise.resolve().then(() => task(signal));
    this.maintenance = promise;
    return promise.finally(() => {
      this.maintenance = undefined;
      this.maintenanceAbort = undefined;
      this.flushIdleWaiters();
    });
  }

  send(message: UserMessage, _target: InboxTarget, _wakeup: boolean): void {
    this.submit(message);
  }

  followup(message: UserMessage): void {
    this.submit(message);
  }

  steer(message: UserMessage): void {
    this.submit(message);
  }

  inject(message: UserMessage): void {
    this.submit(message);
  }

  private submit(message: UserMessage): void {
    const text = message.content
      .filter((block) => block.type === 'text')
      .map((block) => (block as { type: 'text'; text: string }).text)
      .join('\n');
    if (!this.warnedNonText && message.content.some((block) => block.type !== 'text')) {
      this.warnedNonText = true;
      this.logger.warn(
        `session "${this.id}": dropping non-text content blocks — the wire prompt carries plain text only`,
      );
    }
    void this.handle.prompt(text).catch((err) => {
      this.logger.warn(`session "${this.id}": remote prompt failed: ${String(err)}`);
    });
  }

  private applyRemoteStatus(status: RemoteAgentStatus): void {
    const next: AgentStatus = status === 'running' ? 'running' : 'idle';
    if (next === this.statusField) return;
    this.statusField = next;
    if (this.announced) emitAgentEvent(this.pluginCtx, this, 'agent/status', { status: next });
    if (next === 'idle') this.flushIdleWaiters();
  }

  private flushIdleWaiters(): void {
    if (this.statusField !== 'idle' || this.maintenance !== undefined) return;
    for (const resolve of [...this.idleWaiters]) {
      this.idleWaiters.delete(resolve);
      resolve();
    }
  }
}
