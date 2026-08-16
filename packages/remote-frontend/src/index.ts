/**
 * `@dsh-remote/remote-frontend`: frontend-facing services for dsh-remote live
 * mode — `ctx.remoteTransfer` (local↔remote copy + preview), `ctx.remoteMonitor`
 * (periodic read-only probes over the shared transport), and the `remote_copy`
 * model tool for the agent.
 *
 * The default export is the Cordis plugin: it registers both services and
 * tries to attach `remote_copy` to `ctx.tools` (silently skipped when the
 * upstream tools seam is not loaded).
 */
import { Context } from '@deepseek-ai/cordis';
import type { FileSystem } from '@dsh-remote/seams';
import type { RemoteTransport } from '@dsh-remote/remote';
import { RemoteTransfer } from './transfer.js';
import { RemoteMonitor } from './monitor.js';
import { registerRemoteCopyTool } from './tool-copy.js';

export { RemoteTransfer } from './transfer.js';
export type {
  PreviewResult,
  RemoteTransferOptions,
  TransferDirection,
  TransferOptions,
  TransferProgress,
  TransferResult,
} from './transfer.js';
export { RemoteMonitor, buildMetricsProbeCommand, parseMetricsProbe } from './monitor.js';
export type { ParsedMetricsProbe, RemoteMetrics, RemoteMonitorConfig } from './monitor.js';
export { registerRemoteCopyTool, remoteCopyDefinition } from './tool-copy.js';
export type {
  RemoteCopyToolArgs,
  ToolDefinitionAccess,
  ToolRegistryAccess,
  ToolTextContent,
} from './tool-copy.js';

/** Configuration for the default plugin. */
export interface RemoteFrontendConfig {
  /**
   * Remote filesystem lookup per target. Defaults to the session's `ctx.fs`
   * (which points at the connected remote host in live mode) for any target.
   */
  getRemoteFs?: (targetId: string) => FileSystem | undefined;
  /** Transport lookup per target; defaults to `ctx.remoteHub.get(targetId)`. */
  getTransport?: (targetId: string) => RemoteTransport | undefined;
  /** Default monitor poll interval in milliseconds. */
  monitorIntervalMs?: number;
}

export default async function remoteFrontend(
  ctx: Context,
  config: RemoteFrontendConfig = {},
): Promise<void> {
  const getRemoteFs = config.getRemoteFs ?? (() => ctx.fs as FileSystem | undefined);
  const getTransport =
    config.getTransport ?? ((targetId: string) => ctx.remoteHub?.get(targetId));
  await ctx.plugin(RemoteTransfer, { getRemoteFs, getTransport });
  await ctx.plugin(RemoteMonitor, { intervalMs: config.monitorIntervalMs });
  registerRemoteCopyTool(ctx, ctx.remoteTransfer);
}
