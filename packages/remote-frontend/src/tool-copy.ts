/**
 * The `remote_copy` model tool: lets an agent copy a file between a remote
 * SSH target and the local machine in one call, delegating to
 * {@link RemoteTransfer}.
 *
 * Tool registration goes through `ctx.tools`, the upstream
 * `@deepseek-ai/dsh-tools` seam (`packages/core/tools`), which cannot be
 * installed standalone. Per its README the register surface is
 * `ctx.tools.register(definition): () => void` with
 * `ToolDefinition = ToolSchema + output { schema, render } + execute(args, exec)`;
 * this module narrows that to the minimal structural
 * {@link ToolRegistryAccess} below and treats the service as an OPTIONAL
 * dependency: when `ctx.tools` is absent the tool is simply not registered
 * (no error).
 */
import type { Context } from '@deepseek-ai/cordis';
import type { RemoteTransfer } from './transfer.js';

export interface RemoteCopyToolArgs {
  targetId: string;
  direction: 'download' | 'upload';
  remotePath: string;
  localPath: string;
  overwrite?: boolean;
}

/** Minimal text-content item of the upstream tool output contract. */
export interface ToolTextContent {
  type: 'text';
  text: string;
}

/** Minimal structural subset of the upstream `ToolDefinition`. */
export interface ToolDefinitionAccess {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: {
    schema: unknown;
    render: (args: unknown, value: unknown) => ToolTextContent[];
  };
  timeoutMs?: number;
  execute(args: never, exec: { signal: AbortSignal }): Promise<unknown>;
}

/** Minimal structural subset of the upstream `ctx.tools` registry. */
export interface ToolRegistryAccess {
  register(definition: ToolDefinitionAccess): () => void;
}

/** Build the `remote_copy` tool definition bound to a transfer service. */
export function remoteCopyDefinition(transfer: RemoteTransfer): ToolDefinitionAccess {
  return {
    name: 'remote_copy',
    description:
      'Copy a file between a remote SSH target and the local machine. ' +
      "direction 'download' copies remotePath on the target to localPath; " +
      "'upload' copies localPath to remotePath on the target. Fails when the " +
      'destination exists unless overwrite is true.',
    parameters: {
      targetId: {
        type: 'string',
        required: true,
        description: 'Registered remote target id',
      },
      direction: {
        type: 'string',
        required: true,
        enum: ['download', 'upload'],
        description: "'download' = remote→local, 'upload' = local→remote",
      },
      remotePath: { type: 'string', required: true, description: 'Absolute path on the remote host' },
      localPath: { type: 'string', required: true, description: 'Absolute path on the local machine' },
      overwrite: {
        type: 'boolean',
        description: 'Replace an existing destination file (default false)',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    timeoutMs: 300_000,
    async execute(args: RemoteCopyToolArgs, exec: { signal: AbortSignal }) {
      const opts = { overwrite: args.overwrite === true, signal: exec.signal };
      const result =
        args.direction === 'download'
          ? await transfer.copyRemoteToLocal(args.targetId, args.remotePath, args.localPath, opts)
          : await transfer.copyLocalToRemote(args.targetId, args.localPath, args.remotePath, opts);
      return (
        `copied ${result.bytes} bytes from ${result.sourcePath} to ${result.destPath} ` +
        `in ${result.durationMs}ms (${args.direction})`
      );
    },
  };
}

/**
 * Register `remote_copy` on `ctx.tools` when the upstream registry is loaded.
 * Returns the unregister disposer, or `undefined` when `ctx.tools` is absent.
 */
export function registerRemoteCopyTool(
  ctx: Context,
  transfer: RemoteTransfer,
): (() => void) | undefined {
  const tools = (ctx as unknown as { tools?: ToolRegistryAccess }).tools;
  if (typeof tools?.register !== 'function') return undefined;
  return tools.register(remoteCopyDefinition(transfer));
}
