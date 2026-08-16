/**
 * Type-only shims for the dsh sandbox vocabulary (`@deepseek-ai/dsh-sandbox`),
 * vendored because that package cannot be installed standalone (it depends on
 * the unpublished `@deepseek-ai/dsh-type-meta`). Adapted from
 * deepseek-ai/deepseek-harness, packages/sandbox/sandbox (MIT).
 *
 * A bare remote backend never confines, so it ignores `sandboxPolicy` per call;
 * these types exist only to keep the `ctx.fs` signatures source-compatible.
 * Keep structurally aligned with upstream when upgrading.
 */

/** Sandbox enforcement modes (file operations only). */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

/**
 * Per-call sandbox policy: the full mode plus the workspace root every call
 * carries. The bare backend ignores it; a sandboxing backend fences by it.
 */
export interface SandboxExecutionPolicy {
  readonly mode: SandboxMode;
  readonly workspaceRoot: string;
}
