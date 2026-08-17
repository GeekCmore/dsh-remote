/**
 * `@dsh-remote/proxy` — remote-backed implementations of the official dsh
 * session seams for the LOCAL dsh host, so seam-compliant in-process
 * frontends (TUIs like dsh-tianshu-tui / dsh-TUI) attach to a remote
 * headless dsh UNMODIFIED.
 *
 * Mounts, on the plugin context:
 * - `sessions` — the real upstream `SessionStore` (`@deepseek-ai/dsh-session`),
 *   fed by seq-exact mirroring of remote session logs (see `mirror.ts`);
 * - `agents` — the real upstream `AgentRegistry` (`@deepseek-ai/dsh-agent`)
 *   with a factory whose create/resume route to the daemon client and return
 *   fabricated `Agent` facades over mirrored sessions (see `agent.ts`);
 * - `sessionPersistence` — a read-mostly remote-backed subclass of the
 *   upstream abstract `SessionPersistence` (see `persistence.ts`);
 * - approval/question bridging from the remote handle notifications into the
 *   LOCAL `approval/request` waterfall / `userQuestions` service and back
 *   (see `bridges.ts`).
 *
 * The remote side is driven through the `RemoteClient` exposed by the
 * composed `ctx.remoteSessions` provider (`@dsh-remote/remote-daemon`).
 *
 * Usage: `ctx.plugin(RemoteProxyPlugin, { targetId: 'default' })` after the
 * `ctx.remoteSessions` provider (order-independent — `inject` waits).
 */
import { Context } from '@deepseek-ai/cordis';
import { RemoteClient } from '@dsh-remote/client';
import type {} from '@dsh-remote/sessions';
import { RemoteProxy, type RemoteProxyConfig } from './proxy.js';

export { RemoteProxy, type RemoteProxyConfig } from './proxy.js';
export { RemoteSessionStore } from './store.js';
export { RemoteAgentFacade } from './agent.js';
export { RemoteAgentFactory } from './factory.js';
export { RemoteSessionPersistence } from './persistence.js';
export { InteractionBridges, toWireAnswers } from './bridges.js';
export {
  RemoteAgentPresetsCatalog,
  RemoteCatalogs,
  RemoteLlmCatalog,
  RemoteSkillsCatalog,
} from './catalogs.js';
export { SessionMirror, type MirrorDeps, type MirrorOptions } from './mirror.js';
export { appendMirroredEvent, readRemoteHistory, type MirroredWireEvent } from './events.js';

/**
 * Cordis plugin entry. Config: `{ targetId?: string }` (default `'default'`)
 * — a single target per profile in v1.
 */
export function RemoteProxyPlugin(ctx: Context, config?: RemoteProxyConfig): void {
  // The inject callback MUST use its own ctx: the outer fiber declares no
  // inject, so reading `ctx.remoteSessions` there throws "without inject".
  ctx.inject(['remoteSessions'], (injected) => {
    const provider = injected.remoteSessions as unknown as { client?: unknown };
    if (!(provider.client instanceof RemoteClient)) {
      throw new Error(
        '@dsh-remote/proxy: the ctx.remoteSessions provider must expose a ' +
          '@dsh-remote/client RemoteClient as `.client` (compose @dsh-remote/remote-daemon)',
      );
    }
    // NOTE: do not return the instance — an object is not a valid cordis
    // Effect ("Invalid effect"). RemoteProxy self-registers its teardown via
    // ctx.effect on this fiber.
    new RemoteProxy(injected, config ?? {}, provider.client);
  });
}

export default RemoteProxyPlugin;
