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

export function installLiveRuntime(ctx: Context, config: LiveRuntimeConfig): LiveRuntime {
  const targetId = config.targetId ?? 'default'
  const registeredAuth = config.auth.type === 'password'
    ? { type: 'password' as const, password: '' }
    : config.auth
  const hub = new SshRemoteHub(ctx, {
    targets: [{
      id: targetId,
      title: config.title ?? config.host,
      ssh: {
        host: config.host,
        port: config.port ?? 22,
        username: config.username,
        auth: registeredAuth,
        readyTimeoutMs: config.readyTimeoutMs ?? 15_000,
        keepaliveIntervalMs: config.keepaliveIntervalMs ?? 0,
      },
    }],
    autoConnect: false,
  })
  const fs = new SshFileSystem(ctx, {
    target: targetId,
    defaultCwd: config.defaultCwd ?? '/',
  })
  const subprocess = new SshSubprocessRuntime(ctx, { target: targetId })
  const monitor = new RemoteMonitor(ctx, { intervalMs: config.monitorIntervalMs ?? 5_000 })
  const listeners = new Set<() => void>()
  const notify = (): void => {
    for (const listener of listeners) listener()
  }

  ctx.on('remote/connected', (id) => {
    if (id === targetId) notify()
  })
  ctx.on('remote/disconnected', (id) => {
    if (id === targetId) notify()
  })
  ctx.on('remote/degraded', (id) => {
    if (id === targetId) notify()
  })
  ctx.on('remote/metrics', (id) => {
    if (id === targetId) notify()
  })

  const runtime: LiveRuntime = {
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
      const auth = config.auth.type === 'password'
        ? { type: 'password' as const, password: requiredPassword(credentials) }
        : undefined
      await hub.connect(targetId, auth)
      monitor.start(targetId, { intervalMs: config.monitorIntervalMs ?? 5_000 })
      notify()
    },
    async disconnect() {
      monitor.stop(targetId)
      await hub.disconnect(targetId)
      notify()
    },
    async reconnect(credentials?: LiveCredentials) {
      const auth = config.auth.type === 'password'
        ? { type: 'password' as const, password: requiredPassword(credentials) }
        : undefined
      monitor.stop(targetId)
      await hub.disconnect(targetId)
      await hub.connect(targetId, auth)
      monitor.start(targetId, { intervalMs: config.monitorIntervalMs ?? 5_000 })
      notify()
    },
    async exec(request) {
      const transport = hub.get(targetId)
      if (transport === undefined) throw new Error(`remote target ${targetId} is not connected`)
      return execTransport(transport, request)
    },
    async runCommand(request: LiveCommandRequest): Promise<LiveCommandResult> {
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
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }

  ctx.effect(() => () => {
    listeners.clear()
    monitor.stop(targetId)
  }, 'live-runtime: clear listeners')
  return runtime
}
