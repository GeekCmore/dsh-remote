/**
 * One asynchronously-started SSH exec channel projected onto the subprocess
 * seam: the remote bash wrapper (see wrapper.ts) runs the child in its own
 * monitor-mode process group, streams output back as base64 frames, and
 * publishes pgid/status into the provider's private state directory.
 */
import { Buffer } from 'node:buffer';
import { PassThrough, Writable } from 'node:stream';
import { posix } from 'node:path';
import type {
  SubprocessCollect,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputMode,
  SubprocessSpawnSpec,
} from '@dsh-remote/seams';
import type { ExecProcess, RemoteTransport } from '@dsh-remote/remote';
import { FrameDecoder, TailOutputReader } from './output.js';
import { buildSpawnCommand, encodeSpawnHeader, parseStatusText, sq } from './wrapper.js';
import {
  asError,
  connLostError,
  execCapture,
  isAborted,
  isConnLost,
  readRemoteFile,
  signalRemoteGroups,
  waitTick,
} from './util.js';

/** Host surface the handle needs from the runtime (keeps the import graph acyclic). */
export interface SubprocessHost {
  requireTransport(): RemoteTransport;
  /** Undefined while disconnected; run() turns it into a spawn-level failure. */
  runtimeRoot(): string | undefined;
  requireRuntimeRoot(): string;
  childEnvironment(explicit: NodeJS.ProcessEnv | undefined): Promise<string[]>;
  readonly pollMs: number;
  /** Remove one settled handle from the service's live set. */
  untrack(handle: SshSubprocessHandle): void;
}

function isCollect(mode: SubprocessOutputMode): mode is SubprocessCollect {
  return mode !== 'pipe' && mode !== 'inherit';
}

function hasSpill(mode: SubprocessOutputMode): mode is SubprocessCollect & { spill: { maxBytes: number } } {
  return isCollect(mode) && mode.spill !== undefined;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(error: unknown): void;
  settled: boolean;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const state: Deferred<T> = {
    promise: new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    }),
    resolve(value) {
      state.settled = true;
      resolve(value);
    },
    reject(error) {
      state.settled = true;
      reject(error);
    },
    settled: false,
  };
  return state;
}

/** Settle with the promise's value, or `undefined` after `timeoutMs`. */
function withinMs<T>(settlement: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(undefined);
    }, timeoutMs);
    void settlement.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

/** Parse and validate a published process-group id. */
function parsePublishedPgid(raw: string): number {  const value = raw.trim();
  const pgid = Number(value);
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(pgid)) {
    throw new Error(`subprocess-ssh: remote wrapper published invalid process-group id ${JSON.stringify(value)}`);
  }
  // A same-UID remote process can rewrite the state files; refuse ids whose
  // negative form addresses every process (`kill -- -1`) or init's group.
  if (pgid <= 1) {
    throw new Error(`subprocess-ssh: unsafe published process-group id ${pgid}`);
  }
  return pgid;
}

/** Writable that buffers caller stdin until the exec channel exists. */
class DeferredStdin extends Writable {
  constructor(private readonly ready: Promise<ExecProcess>) {
    super({ decodeStrings: false });
  }

  override _write(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    void this.ready
      .then((proc) => {
        proc.write(typeof chunk === 'string' ? chunk : new Uint8Array(chunk));
      })
      .then(
        () => {
          callback();
        },
        (error: unknown) => {
          callback(asError(error));
        },
      );
  }

  override _final(callback: (error?: Error | null) => void): void {
    void this.ready.then((proc) => proc.endStdin()).then(
      () => {
        callback();
      },
      (error: unknown) => {
        callback(asError(error));
      },
    );
  }
}

/**
 * SSH-backed subprocess handle with deferred remote process-group acquisition.
 *
 * `pid` stays -1 until the remote wrapper publishes its process-group id
 * (a spawn-level failure also leaves it -1, matching upstream e2b semantics).
 * Consumers that require a synchronous positive PID are NOT supported by
 * this provider.
 */
export class SshSubprocessHandle implements SubprocessHandle {
  readonly stdin: Writable | undefined;
  readonly stdout: PassThrough | undefined;
  readonly stderr: PassThrough | undefined;
  readonly collected: SubprocessHandle['collected'];
  readonly done: Promise<SubprocessOutcome>;

  private readonly launched = deferred<ExecProcess>();
  private readonly started = deferred<number>();
  private readonly failed = deferred<string>();
  private readonly ended = deferred<string>();
  private readonly channelClosed = deferred<{ code: number | null; signal?: string }>();
  private readonly settled = deferred<void>();
  private readonly stdoutDecoder: FrameDecoder;
  private readonly stderrDecoder: FrameDecoder;
  private readonly outputReleased = new AbortController();
  private readonly stdoutReader: TailOutputReader | undefined;
  private readonly stderrReader: TailOutputReader | undefined;
  private readonly diagnostics: string[] = [];
  private proc: ExecProcess | undefined;
  private outPump: Promise<void> = Promise.resolve();
  private errPump: Promise<void> = Promise.resolve();
  private dir = '';
  private remotePgid = -1;
  private monitorStop = false;
  private spawnFailed = false;
  private outputDrainExpired = false;
  private outputTransportError: Error | undefined;
  private quiescenceProven = false;
  private terminationRequested = false;
  private terminationAttempt: Promise<void> | undefined;
  private terminationFailure: Error | undefined;
  private terminationSignal: NodeJS.Signals | null = null;

  constructor(
    private readonly host: SubprocessHost,
    private readonly spec: SubprocessSpawnSpec,
    readonly id: string,
  ) {
    const root = host.runtimeRoot();
    if (root !== undefined) this.dir = posix.join(root, 'processes', id);
    const outMode = spec.stdio.stdout;
    const errMode = spec.stdio.stderr;
    this.stdout = outMode === 'pipe' ? new PassThrough() : undefined;
    this.stderr = errMode === 'pipe' ? new PassThrough() : undefined;
    this.stdoutReader = isCollect(outMode)
      ? new TailOutputReader(outMode.maxBytes, outMode.spill?.maxBytes, () => posix.join(this.dir, 'stdout.spill'))
      : undefined;
    this.stderrReader = isCollect(errMode)
      ? new TailOutputReader(errMode.maxBytes, errMode.spill?.maxBytes, () => posix.join(this.dir, 'stderr.spill'))
      : undefined;
    this.collected = {
      ...(this.stdoutReader !== undefined ? { stdout: this.stdoutReader } : {}),
      ...(this.stderrReader !== undefined ? { stderr: this.stderrReader } : {}),
    };
    this.stdoutDecoder = new FrameDecoder(
      (line) => this.onControl(line),
      (line) => this.diagnostics.push(line),
    );
    this.stderrDecoder = new FrameDecoder(undefined, (line) => this.diagnostics.push(line));
    if (spec.stdio.stdin === 'pipe') {
      this.stdin = new DeferredStdin(this.launched.promise);
    }
    // The deferreds double as event sources; rejections are consumed where awaited.
    for (const d of [this.launched, this.started, this.failed, this.ended, this.channelClosed]) {
      void d.promise.catch(() => {});
    }
    spec.signal?.addEventListener('abort', this.onAbort, { once: true });
    this.done = this.run();
    void this.done.catch(() => {});
    if (spec.signal?.aborted === true) this.terminate();
  }

  /** Remote process-group id after START; -1 while startup is pending or after it failed. */
  get pid(): number {
    return this.remotePgid;
  }

  /** @inheritdoc */
  terminate(): void {
    if (this.quiescenceProven || this.terminationAttempt !== undefined) return;
    this.terminationRequested = true;
    this.stdout?.destroy();
    this.stderr?.destroy();
    this.terminationFailure = undefined;
    const attempt = this.terminateRemote();
    this.terminationAttempt = attempt;
    void attempt.then(
      () => {
        this.terminationAttempt = undefined;
      },
      (error: unknown) => {
        if (!this.quiescenceProven) this.terminationFailure = asError(error);
        this.terminationAttempt = undefined;
      },
    );
  }

  /** @inheritdoc */
  async waitForExit(signal?: AbortSignal): Promise<boolean> {
    for (;;) {
      if (this.quiescenceProven) return true;
      this.throwTerminationFailure();
      if (signal?.aborted === true) return false;
      if (this.spawnFailed) {
        this.markQuiescent();
        return true;
      }
      let transport: RemoteTransport;
      try {
        transport = this.host.requireTransport();
      } catch {
        // The execution world is gone; nothing left to observe.
        this.markQuiescent();
        return true;
      }
      let exited = this.ended.settled || this.settled.settled;
      let alive = false;
      try {
        if (!exited) {
          const text = await readRemoteFile(transport, this.statusPath(), signal);
          exited = text !== undefined && text.trim().length > 0;
        }
        if (this.remotePgid > 0) {
          alive = await this.probeGroup(transport, this.remotePgid, signal);
        }
      } catch (error: unknown) {
        // Re-read through a helper: TS narrowed `signal?.aborted` above.
        if (isAborted(signal)) return false;
        if (isConnLost(error)) {
          this.markQuiescent();
          return true;
        }
        throw error;
      }
      if (exited && !alive) {
        this.markQuiescent();
        return true;
      }
      if (!(await waitTick(this.host.pollMs, signal))) return false;
    }
  }

  private readonly onAbort = (): void => {
    this.terminate();
  };

  private markQuiescent(): void {
    this.quiescenceProven = true;
    this.terminationFailure = undefined;
  }

  private statusPath(): string {
    return posix.join(this.dir, 'status');
  }

  private async probeGroup(
    transport: RemoteTransport,
    pgid: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    // `kill -0 -<pgid>` exits nonzero once no group member remains. Group
    // members whose leader died are reaped by init rather than lingering as
    // zombies, so the plain probe is an accurate whole-tree liveness test.
    // (No `--` separator: the login shell may be dash, whose kill builtin
    // rejects it; pgids are validated numerals, so this is injection-safe.)
    const { code } = await execCapture(transport, `kill -0 -${pgid}`, signal);
    return code === 0;
  }

  // ------------------------------------------------------------ lifecycle

  private async run(): Promise<SubprocessOutcome> {
    try {
      const transport = this.host.requireTransport();
      const root = this.host.requireRuntimeRoot();
      this.dir = posix.join(root, 'processes', this.id);
      const env = await this.host.childEnvironment(this.spec.env);
      const outMode = this.spec.stdio.stdout;
      const errMode = this.spec.stdio.stderr;
      const header = encodeSpawnHeader({
        argv: this.spec.argv,
        env,
        cwd: this.spec.cwd,
        stdinIgnore: this.spec.stdio.stdin === 'ignore',
        stdoutSpillMax: hasSpill(outMode) ? outMode.spill.maxBytes : undefined,
        stderrSpillMax: hasSpill(errMode) ? errMode.spill.maxBytes : undefined,
      });
      const proc = await transport.exec(buildSpawnCommand(this.id, root));
      this.proc = proc;
      this.launched.resolve(proc);
      void proc.done.then(
        (result) => this.channelClosed.resolve(result),
        () => this.channelClosed.resolve({ code: null }),
      );
      this.outPump = this.pump(proc.stdout, this.stdoutDecoder, 'stdout');
      this.errPump = this.pump(proc.stderr, this.stderrDecoder, 'stderr');
      proc.write(header);
      const stdinMode = this.spec.stdio.stdin;
      if (stdinMode === 'ignore') {
        proc.endStdin();
      } else if (typeof stdinMode === 'object') {
        // Batch stdin is best-effort; exit facts and output remain authoritative.
        try {
          proc.write(stdinMode.data);
          proc.endStdin();
        } catch {
          /* the process closed its input first */
        }
      }
      return await this.monitor(proc);
    } catch (error: unknown) {
      let failure = asError(error);
      const canceledPreparation =
        this.terminationRequested && !this.started.settled && !this.ended.settled;
      if (!this.started.settled && !this.ended.settled && !this.failed.settled) {
        this.spawnFailed = true;
      }
      if (!this.started.settled) this.started.reject(failure);
      if (!this.launched.settled) this.launched.reject(failure);
      if (this.remotePgid > 0 && !this.quiescenceProven) {
        // Monitoring failed after publication: the group may still be live.
        this.terminate();
        try {
          await this.waitForExit();
        } catch (cleanupError: unknown) {
          failure = new AggregateError(
            [failure, asError(cleanupError)],
            'subprocess-ssh: command monitoring failed and process-group rollback did not reach quiescence',
          );
        }
      }
      await this.removeStateDir();
      if (canceledPreparation) {
        // Caller-requested termination during startup settles as a fact, not a failure.
        return { exitCode: null, signal: 'SIGTERM' };
      }
      throw failure;
    } finally {
      this.monitorStop = true;
      this.spec.signal?.removeEventListener('abort', this.onAbort);
      if (this.stdout !== undefined && !this.stdout.destroyed) this.stdout.end();
      if (this.stderr !== undefined && !this.stderr.destroyed) this.stderr.end();
      this.settled.resolve();
      this.host.untrack(this);
    }
  }

  /** Race the END frame, the status-file poll, and channel closure. */
  private async monitor(proc: ExecProcess): Promise<SubprocessOutcome> {
    const statusWatch = this.pollStatus();
    const first = await Promise.race([
      this.ended.promise.then((status) => ({ kind: 'end', status }) as const),
      this.failed.promise.then((message) => ({ kind: 'fail', message }) as const),
      statusWatch.then((status) => ({ kind: 'status', status }) as const),
      this.channelClosed.promise.then(() => ({ kind: 'closed' }) as const),
    ]);
    switch (first.kind) {
      case 'fail':
        throw this.spawnFailure(first.message);
      case 'end':
        // END is emitted after the remote encoder drain; let the local pumps
        // flush their queued frames before settling the outcome.
        await withinMs(Promise.allSettled([this.outPump, this.errPump]), this.spec.graceMs);
        return this.finishOutcome(first.status);
      case 'status': {
        // The direct child exited (status file) but the END frame has not
        // arrived — a descendant may be holding an inherited output pipe
        // open. Bound the drain by graceMs, then cut the channel loose.
        const drained = await withinMs(this.ended.promise, this.spec.graceMs);
        if (drained !== undefined) {
          await withinMs(Promise.allSettled([this.outPump, this.errPump]), this.spec.graceMs);
          return this.finishOutcome(drained);
        }
        this.outputDrainExpired = true;
        this.stdoutReader?.invalidateSpill();
        this.stderrReader?.invalidateSpill();
        this.outputReleased.abort(new Error('subprocess-ssh: output drain grace expired'));
        await proc.kill().catch(() => {});
        await withinMs(Promise.allSettled([this.outPump, this.errPump]), this.spec.graceMs);
        return this.finishOutcome(first.status);
      }
      case 'closed': {
        // The channel closed; drain the pumps first so every queued frame
        // (START/END/FAIL included) has been processed before classifying.
        await withinMs(Promise.allSettled([this.outPump, this.errPump]), this.spec.graceMs);
        if (this.failed.settled) {
          throw this.spawnFailure(await this.failed.promise);
        }
        if (this.ended.settled) {
          return this.finishOutcome(await this.ended.promise);
        }
        const status = await this.readStatusOnce();
        if (status !== undefined) {
          this.outputDrainExpired = true;
          this.stdoutReader?.invalidateSpill();
          this.stderrReader?.invalidateSpill();
          return this.finishOutcome(status);
        }
        if (!this.started.settled) {
          throw this.spawnFailure(undefined);
        }
        throw connLostError('command channel closed before the wrapper published completion');
      }
    }
  }

  private spawnFailure(detail: string | undefined): Error {
    const parts = ['subprocess-ssh: remote spawn failed'];
    if (detail !== undefined) parts.push(detail);
    if (this.diagnostics.length > 0) parts.push(this.diagnostics.join('\n'));
    return new Error(parts.join(': '));
  }

  private finishOutcome(statusText: string): SubprocessOutcome {
    const parsed = parseStatusText(statusText);
    if (!parsed) {
      throw new Error(`subprocess-ssh: remote wrapper published invalid status ${JSON.stringify(statusText)}`);
    }
    if (this.outputTransportError !== undefined) throw this.outputTransportError;
    void this.finalizeSpills();
    // A caller-requested termination converts an ambiguous `128+n` exit code
    // into the delivered signal; a wrapper-reported signal stands as-is.
    if (parsed.signal === null && this.terminationSignal !== null && parsed.exitCode !== null && parsed.exitCode > 128) {
      return { exitCode: null, signal: this.terminationSignal };
    }
    return parsed;
  }

  /** Poll the status file until the wrapper publishes the exit fact. */
  private async pollStatus(): Promise<string> {
    const never = new Promise<string>(() => {});
    for (;;) {
      if (this.monitorStop) return never;
      try {
        const transport = this.host.requireTransport();
        const text = await readRemoteFile(transport, this.statusPath());
        if (text !== undefined && text.trim().length > 0) return text;
      } catch {
        // A lost connection is surfaced through the channel-close race instead.
      }
      if (!(await waitTick(this.host.pollMs))) return never;
    }
  }

  private async readStatusOnce(): Promise<string | undefined> {
    try {
      const transport = this.host.requireTransport();
      const text = await readRemoteFile(transport, this.statusPath());
      return text !== undefined && text.trim().length > 0 ? text : undefined;
    } catch {
      return undefined;
    }
  }

  // ---------------------------------------------------------------- output

  private onControl(line: string): void {
    const match = /^!DSHSSH (START|FAIL|END)(?: (.*))?$/.exec(line);
    if (!match) {
      this.diagnostics.push(line);
      return;
    }
    const [, verb, rest = ''] = match;
    try {
      switch (verb) {
        case 'START': {
          const pgid = parsePublishedPgid(rest);
          this.remotePgid = pgid;
          this.started.resolve(pgid);
          break;
        }
        case 'FAIL': {
          this.failed.resolve(Buffer.from(rest, 'base64').toString('utf8'));
          break;
        }
        case 'END':
          this.ended.resolve(rest);
          break;
      }
    } catch (error: unknown) {
      this.failed.resolve(asError(error).message);
    }
  }

  private async pump(
    iter: AsyncIterable<Uint8Array>,
    decoder: FrameDecoder,
    stream: 'stdout' | 'stderr',
  ): Promise<void> {
    const textDecoder = new TextDecoder('utf-8');
    try {
      for await (const chunk of iter) {
        const bytes = decoder.push(textDecoder.decode(chunk, { stream: true }));
        if (bytes.length > 0) await this.dispatchOutput(stream, bytes);
      }
      const tail = textDecoder.decode();
      if (tail) {
        const bytes = decoder.push(tail);
        if (bytes.length > 0) await this.dispatchOutput(stream, bytes);
      }
      decoder.finish(!this.outputDrainExpired && !this.terminationRequested);
    } catch (error: unknown) {
      this.outputTransportError ??= asError(error);
      const target = stream === 'stdout' ? this.stdout : this.stderr;
      target?.destroy(this.outputTransportError);
    }
  }

  private async dispatchOutput(stream: 'stdout' | 'stderr', bytes: Buffer): Promise<void> {
    if (stream === 'stdout') {
      this.stdoutReader?.push(bytes);
      await this.writeOutput(this.stdout, this.spec.stdio.stdout === 'inherit' ? process.stdout : undefined, bytes);
      return;
    }
    this.stderrReader?.push(bytes);
    await this.writeOutput(this.stderr, this.spec.stdio.stderr === 'inherit' ? process.stderr : undefined, bytes);
  }

  private async writeOutput(
    pipe: PassThrough | undefined,
    inherited: NodeJS.WriteStream | undefined,
    data: Uint8Array,
  ): Promise<void> {
    const target = pipe ?? inherited;
    if (target === undefined || data.length === 0 || this.terminationRequested) return;
    if (target.destroyed) return;
    if (target.write(data)) return;
    await new Promise<void>((resolve, reject) => {
      const onDrain = (): void => {
        cleanup();
        resolve();
      };
      const onClose = (): void => {
        cleanup();
        resolve();
      };
      const onRelease = (): void => {
        cleanup();
        resolve();
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const cleanup = (): void => {
        target.removeListener('drain', onDrain);
        target.removeListener('close', onClose);
        target.removeListener('error', onError);
        this.outputReleased.signal.removeEventListener('abort', onRelease);
      };
      target.once('drain', onDrain);
      target.once('close', onClose);
      target.once('error', onError);
      this.outputReleased.signal.addEventListener('abort', onRelease, { once: true });
      if (this.outputReleased.signal.aborted) onRelease();
    });
  }

  /**
   * Drop spill files that are not useful: output that fit in memory, a drain
   * that expired, or a stream that outgrew the spill cap. Best effort — the
   * runtime root is session-scoped, so residue is bounded by the connection.
   */
  private async finalizeSpills(): Promise<void> {
    const removals: string[] = [];
    const collect = (mode: SubprocessOutputMode, reader: TailOutputReader | undefined, name: string): void => {
      if (!hasSpill(mode) || reader === undefined) return;
      if (this.outputDrainExpired || reader.size <= mode.maxBytes || reader.size > mode.spill.maxBytes) {
        removals.push(posix.join(this.dir, name));
      }
    };
    collect(this.spec.stdio.stdout, this.stdoutReader, 'stdout.spill');
    collect(this.spec.stdio.stderr, this.stderrReader, 'stderr.spill');
    if (removals.length === 0) return;
    try {
      const transport = this.host.requireTransport();
      await execRm(transport, removals);
    } catch {
      /* best-effort private cleanup */
    }
  }

  private async removeStateDir(): Promise<void> {
    if (!this.dir) return;
    try {
      const transport = this.host.requireTransport();
      await execRm(transport, [this.dir], true);
    } catch {
      /* best-effort private cleanup */
    }
  }

  // ----------------------------------------------------------- termination

  private async terminateRemote(): Promise<void> {
    const proc = await this.launched.promise.catch(() => undefined);
    if (proc === undefined) {
      // The exec channel never opened; run() has already settled the failure.
      this.markQuiescent();
      return;
    }
    const pgid = await this.started.promise.catch(() => -1);
    if (pgid <= 1) {
      // The wrapper never published a group: closing the channel kills it.
      try {
        await proc.kill();
      } catch (error: unknown) {
        if (!isConnLost(error)) throw error;
      }
      await this.settled.promise;
      this.markQuiescent();
      return;
    }
    let transport: RemoteTransport;
    try {
      transport = this.host.requireTransport();
    } catch {
      this.markQuiescent();
      return;
    }
    this.terminationSignal = 'SIGTERM';
    try {
      await signalRemoteGroups(transport, [pgid], 'TERM');
      if (await this.waitGroupDead(transport, pgid)) {
        this.markQuiescent();
        return;
      }
    } catch {
      // Failed TERM delivery or observation cannot prove exit; force cleanup still owns the group.
    }
    this.terminationSignal = 'SIGKILL';
    try {
      await signalRemoteGroups(transport, [pgid], 'KILL');
    } catch (error: unknown) {
      if (isConnLost(error)) {
        this.markQuiescent();
        return;
      }
      // The channel kill and the final liveness probe remain independent paths.
    }
    try {
      await proc.kill();
    } catch {
      /* the liveness probe, not either transport's self-report, proves cleanup */
    }
    if (await this.waitGroupDead(transport, pgid)) {
      this.markQuiescent();
      return;
    }
    throw new Error(`subprocess-ssh: remote process group ${pgid} remained live after force termination`);
  }

  private async waitGroupDead(transport: RemoteTransport, pgid: number): Promise<boolean> {
    const deadline = Date.now() + this.spec.graceMs;
    for (;;) {
      let alive: boolean;
      try {
        alive = await this.probeGroup(transport, pgid);
      } catch (error: unknown) {
        if (isConnLost(error)) return true;
        throw error;
      }
      if (!alive) return true;
      if (Date.now() >= deadline) return false;
      await waitTick(Math.min(this.host.pollMs, Math.max(1, deadline - Date.now())));
    }
  }

  private throwTerminationFailure(): void {
    if (this.terminationFailure !== undefined) throw this.terminationFailure;
  }
}

/** `rm -f`/`rm -rf` best-effort cleanup. */
async function execRm(transport: RemoteTransport, paths: string[], recursive = false): Promise<void> {
  const quoted = paths.map((p) => sq(p)).join(' ');
  await execCapture(transport, `rm ${recursive ? '-rf' : '-f'} -- ${quoted}`);
}
