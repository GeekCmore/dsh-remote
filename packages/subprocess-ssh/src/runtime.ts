/**
 * `ctx.subprocess` provider over SSH: the `SubprocessRuntime` seam
 * implemented against a live {@link RemoteTransport} using only exec channels
 * and standard bash/coreutils on the remote host — zero installation.
 *
 * Exec command inventory (the complete list this provider ever runs; the
 * in-memory test fake simulates exactly these):
 *
 *  1. `test -x '<abs>'` and `command -v -- '<name>'` — executable lookup.
 *  2. The spawn wrapper (`bash -c '<SPAWN_WRAPPER>' dsh-ssh-spawn '<id>' '<root>'`)
 *     with the base64 stdin header — see wrapper.ts for the channel protocol.
 *  3. `kill -TERM|-KILL|-0 -<pgid>` — process-group termination/liveness.
 *  4. `cat -- '<path>'` — status/pgid/pid/tty state-file reads.
 *  5. The terminal setup script and PTY wrapper, `ps -o tpgid=,stat= -t`,
 *     `ps -eo sid=,pgid=,stat=`, and `rm -f/-rf` private-state cleanup.
 */
import { randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { SubprocessRuntime } from '@dsh-remote/seams';
import type {
  SubprocessHandle,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@dsh-remote/seams';
import type { RemoteTransport } from '@dsh-remote/remote';
import { RemoteEnvironment, mergeEnvironment } from './environment.js';
import { SshSubprocessHandle } from './process.js';
import type { SubprocessHost } from './process.js';
import { spawnSshTerminal } from './terminal.js';
import { connLostError, execCapture } from './util.js';
import { sq } from './wrapper.js';

/** Construction options for {@link SshSubprocessRuntime}. */
export interface SshSubprocessRuntimeOptions {
  /**
   * Returns the live transport, or `undefined` while disconnected. Every
   * operation resolves it lazily so reconnects are picked up; `undefined`
   * surfaces as an infrastructure-failure Error carrying connection semantics
   * in `cause` (the subprocess seam has no dedicated error class).
   * Mutually exclusive with {@link target}; one of the two is required.
   */
  getTransport?(): RemoteTransport | undefined;
  /**
   * Composition-tree wiring: id of the `ctx.remoteHub` target whose transport
   * (and runtime root) this provider uses. Unlike `getTransport` this is
   * expressible in a declarative (YAML) plugin config, so a patch entry can
   * mount this provider directly. The hub is resolved lazily per call, so
   * mounting order and reconnects are both safe.
   */
  target?: string;
  /**
   * Absolute per-session runtime root on the remote host (private state:
   * process groups, status files, spills). A constant string or a lazy
   * resolver mirroring `getTransport` (each connection owns a fresh root).
   * Defaults to the hub's `runtimeRoot(target)` when `target` is given.
   */
  runtimeRoot?: string | (() => string | undefined);
  /** Remote status/liveness poll cadence in milliseconds. Default 50. */
  pollMs?: number;
}

const DEFAULT_POLL_MS = 50;

/**
 * SSH-backed `ctx.subprocess` implementation. Load it as a cordis plugin with
 * the options above; it registers as the `subprocess` service and terminates
 * all surviving managed process groups when the owning fiber unloads.
 */
export class SshSubprocessRuntime extends SubprocessRuntime implements SubprocessHost {
  readonly pollMs: number;

  private readonly options: SshSubprocessRuntimeOptions;
  private readonly environment: RemoteEnvironment;
  private readonly live = new Set<SshSubprocessHandle>();
  private disposed = false;

  constructor(ctx: Context, options: SshSubprocessRuntimeOptions) {
    super(ctx);
    if (!options.getTransport && options.target === undefined) {
      throw new Error('subprocess-ssh: either getTransport or target is required');
    }
    if (options.getTransport === undefined && options.target !== undefined) {
      const target = options.target;
      options = {
        ...options,
        getTransport: () => ctx.reflect.get('remoteHub', false)?.get(target),
        runtimeRoot: options.runtimeRoot ?? (() => ctx.reflect.get('remoteHub', false)?.runtimeRoot(target)),
      };
    }
    this.options = options;
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.environment = new RemoteEnvironment(options.getTransport!);
    ctx.effect(() => () => this.dispose(), 'subprocess-ssh: terminate managed processes');
  }

  // ------------------------------------------------------------ SubprocessHost

  requireTransport(): RemoteTransport {
    const transport = this.options.getTransport!();
    if (!transport) throw connLostError('no live SSH connection');
    return transport;
  }

  runtimeRoot(): string | undefined {
    const root = this.options.runtimeRoot;
    return typeof root === 'function' ? root() : root;
  }

  requireRuntimeRoot(): string {
    const root = this.runtimeRoot();
    if (root === undefined || !posix.isAbsolute(root)) {
      throw connLostError('remote runtime root unavailable');
    }
    return root;
  }

  async childEnvironment(explicit: NodeJS.ProcessEnv | undefined): Promise<string[]> {
    return mergeEnvironment(await this.environment.base(), explicit);
  }

  untrack(handle: SshSubprocessHandle): void {
    this.live.delete(handle);
  }

  // --------------------------------------------------------- SubprocessRuntime

  override async resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string> {
    signal?.throwIfAborted();
    if (command.length === 0) throw new Error('subprocess-ssh: empty executable name');
    if (posix.isAbsolute(command)) {
      const transport = this.requireTransport();
      // No `--` separator (dash's test builtin rejects it); an absolute path
      // always starts with `/`, so option injection is impossible.
      const { code } = await execCapture(transport, `test -x ${sq(command)}`, signal);
      if (code !== 0) {
        throw new Error(`subprocess-ssh: executable not found or not executable: ${command}`);
      }
      return command;
    }
    if (command.includes('/')) {
      // The resolution base is undefined; fail loud instead of guessing.
      throw new Error(
        `subprocess-ssh: relative executable paths containing separators are not supported: ${command}`,
      );
    }
    if (command.startsWith('-')) {
      throw new Error(`subprocess-ssh: invalid executable name: ${command}`);
    }
    const base = await this.environment.base();
    const merged = mergeEnvironment(base, env);
    const pathEntry = merged.find((entry) => entry.startsWith('PATH='));
    const lookupPath = pathEntry === undefined ? undefined : pathEntry.slice('PATH='.length);
    const transport = this.requireTransport();
    const { code, stdout } = await execCapture(
      transport,
      `command -v -- ${sq(command)}`,
      signal,
      lookupPath === undefined ? undefined : { PATH: lookupPath },
    );
    signal?.throwIfAborted();
    const resolved = stdout.split('\n')[0]?.trim() ?? '';
    if (code !== 0 || resolved.length === 0) {
      throw new Error(`subprocess-ssh: executable not found on remote PATH: ${command}`);
    }
    return resolved;
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    if (this.disposed) throw new Error('subprocess-ssh: runtime is disposed');
    this.validateSpawnSpec(spec);
    const id = randomBytes(6).toString('hex');
    const handle = new SshSubprocessHandle(this, spec, id);
    this.live.add(handle);
    return handle;
  }

  override async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    if (this.disposed) throw new Error('subprocess-ssh: runtime is disposed');
    if (spec.argv.length === 0) throw new Error('subprocess-ssh: terminal argv must be non-empty');
    if (!Number.isFinite(spec.graceMs) || spec.graceMs <= 0) {
      throw new Error('subprocess-ssh: graceMs must be a positive finite number');
    }
    const id = randomBytes(6).toString('hex');
    return spawnSshTerminal(this, spec, id);
  }

  /** Terminate every surviving managed process group and await quiescence. */
  private async dispose(): Promise<void> {
    this.disposed = true;
    const handles = [...this.live];
    for (const handle of handles) handle.terminate();
    await Promise.allSettled(handles.map((handle) => handle.waitForExit()));
    await Promise.allSettled(handles.map((handle) => handle.done));
  }

  private validateSpawnSpec(spec: SubprocessSpawnSpec): void {
    if (spec.argv.length === 0) throw new Error('subprocess-ssh: argv must be non-empty');
    if (spec.argv.some((arg) => arg.includes('\0'))) {
      throw new Error('subprocess-ssh: argv entries must not contain NUL bytes');
    }
    if (typeof spec.cwd !== 'string' || spec.cwd.length === 0) {
      throw new Error('subprocess-ssh: cwd must be a non-empty string');
    }
    if (!Number.isFinite(spec.graceMs) || spec.graceMs <= 0) {
      throw new Error('subprocess-ssh: graceMs must be a positive finite number');
    }
  }
}
