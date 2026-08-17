/**
 * SSH PTY allocation and process-session ownership for the subprocess seam.
 *
 * The terminal wrapper (see wrapper.ts) consumes 0600 setup files, publishes
 * `pid`/`tty`, prints a random boundary marker, and execs the requested argv
 * as the PTY session leader. Everything before the marker (shell noise, echo)
 * is discarded locally.
 */
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { posix } from 'node:path';
import type {
  SubprocessOutcome,
  SubprocessTerminalForeground,
  SubprocessTerminalHandle,
  SubprocessTerminalSignal,
  SubprocessTerminalSpawnSpec,
} from '@dsh-remote/seams';
import type { ExecProcess, RemoteTransport } from '@dsh-remote/remote';
import { buildTerminalCommand, buildTerminalSetupScript, sq } from './wrapper.js';
import { asError, connLostError, delay, execCapture, isConnLost, readRemoteFile, signalRemoteGroups } from './util.js';
import type { SubprocessHost } from './process.js';

/** Discards PTY bootstrap bytes up to (and including) the random marker. */
class BootstrapOutputFilter {
  readonly ready: Promise<void>;

  private readyResolve!: () => void;
  private pending = Buffer.alloc(0);
  private published = false;

  constructor(
    private readonly marker: Buffer,
    private readonly output: PassThrough,
  ) {
    this.ready = new Promise<void>((res) => {
      this.readyResolve = res;
    });
  }

  /** Whether the boundary marker has been observed (even mid-close). */
  get isPublished(): boolean {
    return this.published;
  }

  push(data: Uint8Array): void {
    if (this.published) {
      this.write(data);
      return;
    }
    const combined = Buffer.concat([this.pending, Buffer.from(data)]);
    const markerOffset = combined.indexOf(this.marker);
    if (markerOffset < 0) {
      const retained = Math.min(combined.length, this.marker.length - 1);
      this.pending = Buffer.from(combined.subarray(combined.length - retained));
      return;
    }
    this.published = true;
    this.pending = Buffer.alloc(0);
    this.readyResolve();
    this.write(combined.subarray(markerOffset + this.marker.length));
  }

  private write(data: Uint8Array): void {
    if (data.length > 0 && !this.output.destroyed) this.output.write(data);
  }
}

function parsePositiveId(value: string, message: string): number {
  const raw = value.trim();
  const id = Number(raw);
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(id)) throw new Error(message);
  return id;
}

/** One SSH PTY and every process group in its remote terminal session. */
export class SshTerminalHandle implements SubprocessTerminalHandle {
  readonly done: Promise<SubprocessOutcome>;

  private topLevelExited = false;
  private cleanup: Promise<void> | undefined;
  private terminationSignal: NodeJS.Signals | null = null;
  private readonly operationController = new AbortController();
  private readonly operations = new Set<Promise<unknown>>();

  constructor(
    private readonly host: SubprocessHost,
    private readonly proc: ExecProcess,
    readonly pid: number,
    readonly output: PassThrough,
    private readonly tty: string,
    private readonly stateDir: string,
    private readonly graceMs: number,
  ) {
    this.done = this.waitForCommand();
  }

  // Numeric pid/pgid identities have no reuse fence on the substrate; keeping
  // host round-trips minimal is the mitigation (same posture as upstream).
  /** @inheritdoc */
  write(data: string): Promise<void> {
    return this.trackOperation(async () => {
      if (this.topLevelExited) throw new Error('subprocess-ssh: terminal process has exited');
      this.proc.write(data);
    });
  }

  /** @inheritdoc */
  inspectForeground(): Promise<SubprocessTerminalForeground | undefined> {
    return this.trackOperation((signal) => this.inspectForegroundOnce(signal));
  }

  /** @inheritdoc */
  signalForeground(signal: SubprocessTerminalSignal): Promise<number> {
    return this.trackOperation(async (operationSignal) => {
      const foreground = await this.inspectForegroundOnce(operationSignal);
      if (foreground === undefined) {
        throw new Error(`subprocess-ssh: cannot resolve foreground process group for terminal ${this.pid}`);
      }
      if (signal === 'SIGKILL' && foreground.processGroupId === this.pid) {
        throw new Error('refusing to SIGKILL the terminal shell; terminate the terminal session instead');
      }
      const transport = this.host.requireTransport();
      const { code, stderr } = await execCapture(
        transport,
        `kill -${signal.slice(3)} -${foreground.processGroupId}`,
        operationSignal,
      );
      if (code !== 0) {
        throw new Error(`subprocess-ssh: signal ${signal} to group ${foreground.processGroupId} failed: ${stderr.trim()}`);
      }
      return foreground.processGroupId;
    });
  }

  /** @inheritdoc */
  terminate(): Promise<void> {
    if (this.cleanup !== undefined) return this.cleanup;
    this.operationController.abort(new Error('subprocess-ssh: terminal is terminating'));
    const cleanup = this.closeAfterOperations();
    this.cleanup = cleanup;
    void cleanup.catch(() => {
      // A failed teardown stays retryable, matching the upstream adapter.
      this.cleanup = undefined;
    });
    return cleanup;
  }

  private async inspectForegroundOnce(
    signal: AbortSignal,
  ): Promise<SubprocessTerminalForeground | undefined> {
    const transport = this.host.requireTransport();
    let result: { code: number | null; stdout: string; stderr: string };
    try {
      result = await execCapture(transport, `ps -o tpgid=,stat= -t ${sq(this.tty)}`, signal);
    } catch (error: unknown) {
      if (this.topLevelExited) return undefined;
      throw error;
    }
    if (result.code !== 0 || result.stdout.trim().length === 0) return undefined;
    let processGroupId: number | undefined;
    let inputWaiting = false;
    for (const line of result.stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [tpgidRaw, stat = ''] = trimmed.split(/\s+/);
      const tpgid = parsePositiveId(
        tpgidRaw ?? '',
        `subprocess-ssh: cannot resolve foreground process group for terminal ${this.pid}`,
      );
      processGroupId ??= tpgid;
      // Best-effort heuristic: a sleeping (interruptible) foreground member is
      // almost always blocked on tty input. There is no syscall-level proof
      // available through ps, so consumers must treat this as advisory.
      if (stat.startsWith('S')) inputWaiting = true;
    }
    if (processGroupId === undefined) return undefined;
    return { processGroupId, inputWaiting };
  }

  private trackOperation<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.operationController.signal.aborted) {
      return Promise.reject(new Error('subprocess-ssh: terminal is terminating'));
    }
    const pending = operation(this.operationController.signal);
    this.operations.add(pending);
    void pending.then(
      () => {
        this.operations.delete(pending);
      },
      () => {
        this.operations.delete(pending);
      },
    );
    return pending;
  }

  private async closeAfterOperations(): Promise<void> {
    await Promise.allSettled(this.operations);
    await this.closeOnce();
  }

  private async waitForCommand(): Promise<SubprocessOutcome> {
    try {
      const result = await this.proc.done;
      if (result.signal) {
        const name = result.signal.startsWith('SIG') ? result.signal : `SIG${result.signal}`;
        return { exitCode: result.code, signal: name as NodeJS.Signals };
      }
      if (result.code === null) {
        // An exec channel that closes without an exit status and without a
        // caller-requested termination is a live transport failure.
        if (this.terminationSignal !== null) return { exitCode: null, signal: this.terminationSignal };
        throw connLostError('terminal channel closed without an exit status');
      }
      return { exitCode: result.code, signal: null };
    } finally {
      this.topLevelExited = true;
      if (!this.output.destroyed) this.output.end();
    }
  }

  /** All live process groups in this terminal's remote session. */
  private async sessionGroups(transport: RemoteTransport): Promise<number[]> {
    const { code, stdout } = await execCapture(transport, 'ps -eo sid=,pgid=,stat=');
    if (code !== 0) return [];
    const groups = new Set<number>();
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || /^SID\s/.test(trimmed)) continue;
      const [sidRaw, pgidRaw, stat = ''] = trimmed.split(/\s+/);
      if (Number(sidRaw) !== this.pid) continue;
      if (/^[ZXx]/.test(stat)) continue; // zombies/defunct are already dead
      const pgid = Number(pgidRaw);
      if (Number.isSafeInteger(pgid) && pgid > 1) groups.add(pgid);
    }
    return [...groups];
  }

  private async awaitSessionEmpty(
    transport: RemoteTransport,
    graceMs: number,
    kill: boolean,
  ): Promise<number[]> {
    const deadline = Date.now() + graceMs;
    for (;;) {
      const groups = await this.sessionGroups(transport);
      if (groups.length === 0) return groups;
      if (kill) {
        await signalRemoteGroups(transport, groups, 'KILL');
        if (Date.now() >= deadline) return this.sessionGroups(transport);
      } else if (Date.now() >= deadline) {
        return groups;
      }
      await delay(Math.min(this.host.pollMs, Math.max(1, deadline - Date.now())));
    }
  }

  private async closeOnce(): Promise<void> {
    let transport: RemoteTransport;
    try {
      transport = this.host.requireTransport();
    } catch {
      // The execution world is gone; the session cannot have survived it.
      await this.proc.kill().catch(() => {});
      return;
    }
    let groups: number[] = [];
    try {
      groups = await this.sessionGroups(transport);
    } catch (error: unknown) {
      if (!isConnLost(error)) throw error;
    }
    if (groups.length > 0) {
      this.terminationSignal = 'SIGTERM';
      await signalRemoteGroups(transport, groups, 'TERM');
      groups = await this.awaitSessionEmpty(transport, this.graceMs, false);
    }
    if (groups.length === 0 && !this.topLevelExited) {
      await Promise.race([this.done.catch(() => undefined), delay(this.graceMs)]);
    }
    if (groups.length > 0 || !this.topLevelExited) {
      this.terminationSignal = 'SIGKILL';
      try {
        await this.proc.kill();
      } catch (error: unknown) {
        if (!isConnLost(error)) throw error;
        return;
      }
      groups = await this.awaitSessionEmpty(transport, this.graceMs, true);
      if (!this.topLevelExited) {
        await Promise.race([this.done.catch(() => undefined), delay(this.graceMs)]);
      }
    }
    if (groups.length > 0) {
      throw new Error(`subprocess-ssh: terminal cleanup failed; surviving process groups: ${groups.join(', ')}`);
    }
    if (!this.topLevelExited) {
      throw new Error(`subprocess-ssh: terminal cleanup failed; surviving pid: ${this.pid}`);
    }
    try {
      await execCapture(transport, `rm -rf -- ${sq(this.stateDir)}`);
    } catch {
      /* best-effort private cleanup */
    }
  }
}

/**
 * Allocate an SSH PTY, replace the wrapper with the requested argv, and
 * return only after the private marker has been observed on the output.
 */
export async function spawnSshTerminal(
  host: SubprocessHost,
  spec: SubprocessTerminalSpawnSpec,
  id: string,
): Promise<SubprocessTerminalHandle> {
  spec.signal?.throwIfAborted();
  const transport = host.requireTransport();
  const root = host.requireRuntimeRoot();
  const dir = posix.join(root, 'terminals', id);
  const env = await host.childEnvironment(spec.env);
  let term = env.find((entry) => entry.startsWith('TERM='))?.slice('TERM='.length);
  if (term === undefined) {
    // The PTY carries TERM via the pty-req; keep the process env in sync so
    // remote programs see the same value.
    term = 'xterm-256color';
    env.push(`TERM=${term}`);
  }
  const marker = `dsh-ssh-bootstrap:${randomUUID()}`;
  const output = new PassThrough();
  const filter = new BootstrapOutputFilter(Buffer.from(marker, 'utf8'), output);
  let proc: ExecProcess | undefined;
  try {
    const setup = buildTerminalSetupScript(dir, {
      argv: [...spec.argv],
      env,
      cwd: spec.cwd,
      marker,
    });
    const setupResult = await execCapture(transport, setup, spec.signal);
    if (setupResult.code !== 0) {
      throw new Error(`subprocess-ssh: terminal state setup failed: ${setupResult.stderr.trim()}`);
    }
    proc = await transport.exec(buildTerminalCommand(id, root), {
      pty: { rows: spec.rows, cols: spec.cols, term },
      ...(spec.signal === undefined ? {} : { signal: spec.signal }),
    });
    const pump = (async () => {
      try {
        for await (const chunk of proc!.stdout) filter.push(chunk);
      } catch (error: unknown) {
        output.destroy(asError(error));
      } finally {
        if (!output.destroyed) output.end();
      }
    })();
    void pump.catch(() => {});
    // Wait for the bootstrap boundary (or an early exit / caller abort).
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (complete: () => void): void => {
        if (settled) return;
        settled = true;
        spec.signal?.removeEventListener('abort', onAbort);
        complete();
      };
      const onExit = (): void => {
        // The boundary frame may sit in the pump queue when the channel
        // closes right behind it: drain the pump before classifying.
        void pump.then(() => {
          if (filter.isPublished) {
            finish(resolve);
            return;
          }
          void (async () => {
            let detail: string | undefined;
            try {
              detail = (await readRemoteFile(transport, posix.join(dir, 'error'), spec.signal))?.trim();
            } catch {
              // Preserve the allocation failure when its diagnostic cannot be read.
            }
            finish(() => {
              if (filter.isPublished) {
                resolve();
              } else {
                const suffix = detail ? `: ${detail}` : '';
                reject(new Error(`subprocess-ssh: terminal exited before publishing its output boundary${suffix}`));
              }
            });
          })();
        });
      };
      const onAbort = (): void => {
        finish(() => {
          reject(asError(spec.signal?.reason ?? new Error('subprocess-ssh: terminal allocation aborted')));
        });
      };
      spec.signal?.addEventListener('abort', onAbort, { once: true });
      void filter.ready.then(() => {
        finish(resolve);
      });
      void proc!.done.then(onExit, onExit);
    });
    spec.signal?.throwIfAborted();
    const pidRaw = await readRemoteFile(transport, posix.join(dir, 'pid'), spec.signal);
    if (pidRaw === undefined) throw new Error('subprocess-ssh: terminal did not publish its pid');
    const pid = parsePositiveId(pidRaw, `subprocess-ssh: terminal published invalid pid ${JSON.stringify(pidRaw)}`);
    const ttyRaw = await readRemoteFile(transport, posix.join(dir, 'tty'), spec.signal);
    if (ttyRaw === undefined || ttyRaw.trim().length === 0) {
      throw new Error('subprocess-ssh: terminal did not publish its tty');
    }
    return new SshTerminalHandle(host, proc, pid, output, ttyRaw.trim(), dir, spec.graceMs);
  } catch (error: unknown) {
    output.destroy();
    // Roll back: close the channel (kills the wrapper/child session leader)
    // and drop the private state. Best effort — the runtime root bounds residue.
    if (proc !== undefined) {
      try {
        await proc.kill();
      } catch (cleanupError: unknown) {
        if (!isConnLost(cleanupError)) {
          throw new AggregateError([asError(error), asError(cleanupError)], asError(error).message);
        }
      }
    }
    try {
      await execCapture(transport, `rm -rf -- ${sq(dir)}`);
    } catch {
      /* best-effort private cleanup */
    }
    throw error;
  }
}
