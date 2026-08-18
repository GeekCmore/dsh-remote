import type { Context } from '@deepseek-ai/cordis'

export type LiveConnectionStatus = 'connected' | 'connecting' | 'disconnected' | 'degraded'

export type LiveAuth =
  | { type: 'agent' }
  | { type: 'key'; privateKeyPath: string; passphrase?: string }
  | { type: 'password' }

export interface LiveCredentials {
  password?: string
}

export interface LiveRuntimeConfig {
  targetId?: string
  title?: string
  host: string
  port?: number
  username: string
  auth: LiveAuth
  readyTimeoutMs?: number
  keepaliveIntervalMs?: number
  defaultCwd?: string
  monitorIntervalMs?: number
  /** Verify the SSH server host key before authentication proceeds. */
  hostVerifier?: (fingerprint: string, hostKey: Buffer) => boolean | Promise<boolean>
}

export interface LiveMetrics {
  at: number
  loadavg: [number, number, number]
  memTotalBytes: number
  memAvailableBytes: number
  cpuBusyRatio?: number
  diskTotalBytes?: number
  diskFreeBytes?: number
  processCount?: number
  error?: string
}

export interface LiveExecRequest {
  command: string
  cwd?: string
  signal?: AbortSignal
}

export interface LiveExecResult {
  exitCode: number | null
  signal?: string
  stdout: string
  stderr: string
}

export interface LiveCommandRequest extends LiveExecRequest {
  timeoutMs?: number
}

export interface LiveCommandResult extends LiveExecResult {
  timedOut: boolean
}

export interface LiveHubHandle {
  status(id: string): LiveConnectionStatus
  runtimeRoot(id: string): string | undefined
  connect(id: string): Promise<unknown>
  disconnect(id: string): Promise<void>
}

export interface LiveMonitorHandle {
  start(id: string, options?: { intervalMs?: number }): void
  stop(id: string): void
  snapshot(id: string): LiveMetrics | undefined
}

export interface LiveRuntime {
  readonly targetId: string
  readonly hub: LiveHubHandle
  readonly fs: object
  readonly subprocess: object
  readonly monitor: LiveMonitorHandle
  readonly status: LiveConnectionStatus
  readonly runtimeRoot: string | undefined
  readonly metrics: LiveMetrics | undefined
  connect(credentials?: LiveCredentials): Promise<void>
  disconnect(): Promise<void>
  reconnect(credentials?: LiveCredentials): Promise<void>
  exec(request: LiveExecRequest): Promise<LiveExecResult>
  runCommand(request: LiveCommandRequest): Promise<LiveCommandResult>
  subscribe(listener: () => void): () => void
}

export declare function installLiveRuntime(ctx: Context, config: LiveRuntimeConfig): LiveRuntime
