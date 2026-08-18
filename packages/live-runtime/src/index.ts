import type { Context } from '@deepseek-ai/cordis'
import { SshRemoteHub } from '../../remote-ssh/src/hub-ssh.js'
import { SshFileSystem } from '../../fs-ssh/src/fs-ssh.js'
import { SshSubprocessRuntime } from '../../subprocess-ssh/src/runtime.js'
import { RemoteMonitor } from '../../remote-frontend/src/monitor.js'
import type { RemoteTransport } from '@dsh-remote/remote'
import type {
  LiveAuth,
  LiveCommandRequest,
  LiveCommandResult,
  LiveCredentials,
  LiveExecRequest,
  LiveExecResult,
  LiveMetrics,
  LiveRuntime,
  LiveRuntimeConfig,
  LiveRuntimeGroup,
} from '../types/index.js'

export type {
  LiveAuth,
  LiveCommandRequest,
  LiveCommandResult,
  LiveConnectionStatus,
  LiveCredentials,
  LiveExecRequest,
  LiveExecResult,
  LiveHubHandle,
  LiveMetrics,
  LiveMonitorHandle,
  LiveRuntime,
  LiveRuntimeConfig,
  LiveRuntimeGroup,
} from '../types/index.js'

const OUTPUT_LIMIT_BYTES = 1024 * 1024
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000

async function collect(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = []
  for await (const chunk of stream) chunks.push(chunk)
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0)
  const output = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.length
  }
  return new TextDecoder().decode(output)
}

async function execTransport(
  transport: RemoteTransport,
  request: LiveExecRequest,
): Promise<LiveExecResult> {
  const process = await transport.exec(request.command, {
    cwd: request.cwd,
    signal: request.signal,
  })
  const [stdout, stderr, outcome] = await Promise.all([
    collect(process.stdout),
    collect(process.stderr),
    process.done,
  ])
  return {
    exitCode: outcome.code,
    ...(outcome.signal === undefined ? {} : { signal: outcome.signal }),
    stdout,
    stderr,
  }
}

function requiredPassword(credentials: LiveCredentials | undefined): string {
  if (credentials?.password === undefined || credentials.password.length === 0) {
    throw new Error('SSH password is required')
  }
  return credentials.password
}

export function installLiveRuntimeGroup(
  ctx: Context,
  configs: readonly LiveRuntimeConfig[],
  initialTargetId?: string,
): LiveRuntimeGroup {
  if (configs.length === 0) throw new Error('live-runtime: at least one target is required')
  const entries = configs.map(config => ({ config, targetId: config.targetId ?? 'default' }))
  const ids = new Set<string>()
  for (const entry of entries) {
    if (ids.has(entry.targetId)) throw new Error(`live-runtime: duplicate target id: ${entry.targetId}`)
    ids.add(entry.targetId)
  }
  let activeTargetId = initialTargetId ?? entries[0]!.targetId
  if (!ids.has(activeTargetId)) throw new Error(`live-runtime: unknown initial target: ${activeTargetId}`)
  let connectingTargetId: string | undefined
  const configById = new Map(entries.map(entry => [entry.targetId, entry.config] as const))
  const hub = new SshRemoteHub(ctx, {
    targets: entries.map(({ config, targetId }) => ({
      id: targetId,
      title: config.title ?? config.host,
      ssh: {
        host: config.host,
        port: config.port ?? 22,
        username: config.username,
        auth: config.auth.type === 'password'
          ? { type: 'password' as const, password: '' }
          : config.auth,
        readyTimeoutMs: config.readyTimeoutMs ?? 15_000,
        keepaliveIntervalMs: config.keepaliveIntervalMs ?? 0,
      },
    })),
    hostVerifier: (fingerprint, hostKey) => {
      if (connectingTargetId === undefined) return true
      const verifier = configById.get(connectingTargetId)?.hostVerifier
      return verifier?.(fingerprint, hostKey) ?? true
    },
    autoConnect: false,
  })
  const fs = new SshFileSystem(ctx, {
    getTransport: () => hub.get(activeTargetId),
    defaultCwd: configById.get(activeTargetId)?.defaultCwd ?? '/',
  })
  const subprocess = new SshSubprocessRuntime(ctx, {
    getTransport: () => hub.get(activeTargetId),
    runtimeRoot: () => hub.runtimeRoot(activeTargetId),
  })
  const monitor = new RemoteMonitor(ctx, { intervalMs: entries[0]!.config.monitorIntervalMs ?? 5_000 })
  const listeners = new Map<string, Set<() => void>>(entries.map(entry => [entry.targetId, new Set()]))
  const groupListeners = new Set<() => void>()
  const notify = (targetId: string): void => {
    for (const listener of listeners.get(targetId) ?? []) listener()
    for (const listener of groupListeners) listener()
  }

  ctx.on('remote/connected', (id) => {
    if (ids.has(id)) notify(id)
  })
  ctx.on('remote/disconnected', (id) => {
    if (ids.has(id)) notify(id)
  })
  ctx.on('remote/degraded', (id) => {
    if (ids.has(id)) notify(id)
  })
  ctx.on('remote/metrics', (id) => {
    if (ids.has(id)) notify(id)
  })

  const runtimes = entries.map(({ config, targetId }): LiveRuntime => ({
    targetId,
    hub,
    fs,
    subprocess,
    monitor,
    get status() {
      return hub.status(targetId)
    },
    get runtimeRoot() {
      return hub.runtimeRoot(targetId)
    },
    get metrics() {
      return monitor.snapshot(targetId) as LiveMetrics | undefined
    },
    async connect(credentials?: LiveCredentials) {
      if (targetId !== activeTargetId) throw new Error(`remote target ${targetId} is not active`)
      const auth = config.auth.type === 'password'
        ? { type: 'password' as const, password: requiredPassword(credentials) }
        : undefined
      connectingTargetId = targetId
      try {
        await hub.connect(targetId, auth)
      } finally {
        connectingTargetId = undefined
      }
      monitor.start(targetId, { intervalMs: config.monitorIntervalMs ?? 5_000 })
      notify(targetId)
    },
    async disconnect() {
      monitor.stop(targetId)
      await hub.disconnect(targetId)
      notify(targetId)
    },
    async reconnect(credentials?: LiveCredentials) {
      if (targetId !== activeTargetId) throw new Error(`remote target ${targetId} is not active`)
      const auth = config.auth.type === 'password'
        ? { type: 'password' as const, password: requiredPassword(credentials) }
        : undefined
      monitor.stop(targetId)
      await hub.disconnect(targetId)
      connectingTargetId = targetId
      try {
        await hub.connect(targetId, auth)
      } finally {
        connectingTargetId = undefined
      }
      monitor.start(targetId, { intervalMs: config.monitorIntervalMs ?? 5_000 })
      notify(targetId)
    },
    async exec(request) {
      if (targetId !== activeTargetId) throw new Error(`remote target ${targetId} is not active`)
      const transport = hub.get(targetId)
      if (transport === undefined) throw new Error(`remote target ${targetId} is not connected`)
      return execTransport(transport, request)
    },
    async runCommand(request: LiveCommandRequest): Promise<LiveCommandResult> {
      if (targetId !== activeTargetId) throw new Error(`remote target ${targetId} is not active`)
      const timeout = new AbortController()
      const timeoutMs = request.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
      const timer = setTimeout(() => timeout.abort(new Error('remote command timed out')), timeoutMs)
      timer.unref?.()
      const signal = request.signal === undefined
        ? timeout.signal
        : AbortSignal.any([request.signal, timeout.signal])
      const handle = subprocess.spawn({
        argv: ['/bin/sh', '-lc', request.command],
        cwd: request.cwd ?? config.defaultCwd ?? '/',
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: OUTPUT_LIMIT_BYTES },
          stderr: { maxBytes: OUTPUT_LIMIT_BYTES },
        },
        graceMs: 2_000,
        signal,
      })
      try {
        const outcome = await handle.done
        const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
        const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
        if (request.signal?.aborted === true) request.signal.throwIfAborted()
        return {
          exitCode: outcome.exitCode,
          ...(outcome.signal === null ? {} : { signal: outcome.signal }),
          stdout,
          stderr,
          timedOut: timeout.signal.aborted,
        }
      } finally {
        clearTimeout(timer)
      }
    },
    subscribe(listener) {
      listeners.get(targetId)!.add(listener)
      return () => listeners.get(targetId)?.delete(listener)
    },
  }))

  const group: LiveRuntimeGroup = {
    runtimes,
    get activeTargetId() {
      return activeTargetId
    },
    activate(targetId) {
      const runtime = runtimes.find(candidate => candidate.targetId === targetId)
      if (runtime === undefined) throw new Error(`live-runtime: unknown target: ${targetId}`)
      if (targetId !== activeTargetId) {
        activeTargetId = targetId
        notify(targetId)
      }
      return runtime
    },
    get(targetId) {
      return runtimes.find(runtime => runtime.targetId === targetId)
    },
    subscribe(listener) {
      groupListeners.add(listener)
      return () => groupListeners.delete(listener)
    },
  }

  ctx.effect(() => () => {
    for (const targetListeners of listeners.values()) targetListeners.clear()
    groupListeners.clear()
    for (const { targetId } of entries) monitor.stop(targetId)
  }, 'live-runtime: clear listeners')
  return group
}

export function installLiveRuntime(ctx: Context, config: LiveRuntimeConfig): LiveRuntime {
  return installLiveRuntimeGroup(ctx, [config]).runtimes[0]!
}
