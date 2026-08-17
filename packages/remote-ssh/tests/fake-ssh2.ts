/**
 * Controllable in-memory fakes for the `ssh2` module, wired in via
 * `vi.mock('ssh2', ...)`. No real network or SSH involved.
 */

import { EventEmitter } from 'node:events';
import { PassThrough, Readable, Writable } from 'node:stream';

/** Script for one exec channel. */
export interface ExecSpec {
  /** Chunks emitted on stdout before EOF. */
  stdout?: Array<string | Uint8Array>;
  /** Chunks emitted on stderr before EOF. */
  stderr?: Array<string | Uint8Array>;
  /** Exit code for the 'close' event (default 0). */
  code?: number | null;
  /** Exit signal for the 'close' event. */
  signal?: string;
  /** Never close on its own; the test drives `channel.close()`. */
  manual?: boolean;
  /** Fail the `exec` callback with this error instead of a channel. */
  error?: Error;
}

/** Fake exec channel: duplex stdin capture + stdout/stderr streams. */
export class FakeChannel extends EventEmitter {
  private readonly out = new PassThrough();
  readonly stderr = new PassThrough();
  /** Everything written to the process stdin. */
  readonly written: Buffer[] = [];
  stdinEnded = false;
  destroyed = false;

  write(chunk: Uint8Array | string): boolean {
    this.written.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return true;
  }

  end(): void {
    this.stdinEnded = true;
  }

  close(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('close', undefined, undefined);
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return this.out[Symbol.asyncIterator]();
  }

  run(spec: ExecSpec): void {
    setImmediate(() => {
      for (const chunk of spec.stdout ?? []) this.out.write(chunk);
      this.out.end();
      for (const chunk of spec.stderr ?? []) this.stderr.write(chunk);
      this.stderr.end();
      if (!spec.manual) {
        setImmediate(() => this.emit('close', spec.code ?? 0, spec.signal));
      }
    });
  }
}

/** Build an SFTP-style error carrying a numeric status code. */
export function sftpError(code: number, message: string): Error & { code: number } {
  return Object.assign(new Error(message), { code });
}

interface StatsLike {
  size: number;
  mode: number;
  mtime: number;
  atime: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

function dirName(path: string): string {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** Fake SFTP subsystem over an in-memory file table. */
export class FakeSftp extends EventEmitter {
  readonly files = new Map<string, Buffer>();
  readonly dirs = new Set<string>(['/']);
  /** Per-method failure override, checked before the in-memory behavior. */
  readonly fail = new Map<string, Error & { code?: number }>();

  private statsFor(path: string, size: number, isDir: boolean): StatsLike {
    return {
      size,
      mode: isDir ? 0o40755 : 0o100644,
      mtime: 0,
      atime: 0,
      isFile: () => !isDir,
      isDirectory: () => isDir,
      isSymbolicLink: () => false,
    };
  }

  private lookup(path: string): { stats: StatsLike } | { err: Error & { code: number } } {
    if (this.files.has(path)) return { stats: this.statsFor(path, this.files.get(path)!.length, false) };
    if (this.dirs.has(path)) return { stats: this.statsFor(path, 0, true) };
    return { err: sftpError(2, `No such file: ${path}`) };
  }

  stat(path: string, cb: (err: Error | undefined, stats?: StatsLike) => void): void {
    process.nextTick(() => {
      const forced = this.fail.get('stat');
      if (forced) return cb(forced);
      const found = this.lookup(path);
      'err' in found ? cb(found.err) : cb(undefined, found.stats);
    });
  }

  lstat(path: string, cb: (err: Error | undefined, stats?: StatsLike) => void): void {
    this.stat(path, cb);
  }

  readdir(path: string, cb: (err: Error | undefined, list?: Array<{ filename: string; longname: string; attrs: StatsLike }>) => void): void {
    process.nextTick(() => {
      const forced = this.fail.get('readdir');
      if (forced) return cb(forced);
      if (!this.dirs.has(path)) return cb(sftpError(2, `No such file: ${path}`));
      const list = [...this.files.entries()]
        .filter(([file]) => dirName(file) === path)
        .map(([file, content]) => ({
          filename: baseName(file),
          longname: file,
          attrs: this.statsFor(file, content.length, false),
        }));
      cb(undefined, list);
    });
  }

  mkdir(path: string, attrsOrCb: unknown, maybeCb?: (err?: Error) => void): void {
    const cb = (typeof attrsOrCb === 'function' ? attrsOrCb : maybeCb) as (err?: Error) => void;
    process.nextTick(() => {
      const forced = this.fail.get('mkdir');
      if (forced) return cb(forced);
      this.dirs.add(path);
      cb();
    });
  }

  rename(src: string, dest: string, cb: (err?: Error) => void): void {
    process.nextTick(() => {
      const forced = this.fail.get('rename');
      if (forced) return cb(forced);
      const content = this.files.get(src);
      if (content === undefined) return cb(sftpError(2, `No such file: ${src}`));
      this.files.delete(src);
      this.files.set(dest, content);
      cb();
    });
  }

  unlink(path: string, cb: (err?: Error) => void): void {
    process.nextTick(() => {
      const forced = this.fail.get('unlink');
      if (forced) return cb(forced);
      if (!this.files.delete(path)) return cb(sftpError(2, `No such file: ${path}`));
      cb();
    });
  }

  rmdir(path: string, cb: (err?: Error) => void): void {
    process.nextTick(() => {
      const forced = this.fail.get('rmdir');
      if (forced) return cb(forced);
      if (!this.dirs.delete(path)) return cb(sftpError(2, `No such file: ${path}`));
      cb();
    });
  }

  createReadStream(path: string): Readable & { close(cb?: (err?: Error) => void): void } {
    const content = this.files.get(path);
    const stream = new Readable({
      read() {
        if (content) this.push(content);
        this.push(null);
      },
    });
    return Object.assign(stream, {
      close(cb?: (err?: Error) => void): void {
        cb?.();
      },
    });
  }

  createWriteStream(path: string): Writable {
    const chunks: Buffer[] = [];
    const files = this.files;
    return new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
      final(callback) {
        files.set(path, Buffer.concat(chunks));
        callback();
      },
    });
  }
}

/** Fake ssh2 `Client`. */
export class FakeClient extends EventEmitter {
  static instances: FakeClient[] = [];
  /** When set, the next `connect()` fails with this error. */
  static nextConnectError: Error | undefined;
  /** Fallback exec behavior when the instance has no `execHandler`. */
  static defaultExec: ((command: string, opts: Record<string, unknown>) => ExecSpec) | undefined;
  static deferReady = false;

  static reset(): void {
    FakeClient.instances = [];
    FakeClient.nextConnectError = undefined;
    FakeClient.defaultExec = undefined;
    FakeClient.deferReady = false;
  }

  /** Latest created instance (the one the transport under test uses). */
  static latest(): FakeClient {
    const client = FakeClient.instances[FakeClient.instances.length - 1];
    if (!client) throw new Error('no FakeClient created yet');
    return client;
  }

  connectOptions: Record<string, unknown> | undefined;
  connectOptionsAtCall: Record<string, unknown> | undefined;
  ended = false;
  execHandler: ((command: string, opts: Record<string, unknown>) => ExecSpec) | undefined;
  sftpError: Error | undefined;
  sftpImpl: FakeSftp | undefined;
  /** Every exec channel created, in order. */
  readonly channels: FakeChannel[] = [];

  constructor() {
    super();
    FakeClient.instances.push(this);
  }

  connect(options: Record<string, unknown>): this {
    this.connectOptions = options;
    this.connectOptionsAtCall = { ...options };
    const error = FakeClient.nextConnectError;
    FakeClient.nextConnectError = undefined;
    process.nextTick(() => {
      if (error) this.emit('error', error);
      else if (!FakeClient.deferReady) this.emit('ready');
    });
    return this;
  }

  ready(): void {
    this.emit('ready');
  }

  exec(command: string, opts: unknown, cb?: unknown): this {
    const options = (typeof opts === 'function' ? {} : opts) as Record<string, unknown>;
    const callback = (typeof opts === 'function' ? opts : cb) as (err: Error | null, channel?: FakeChannel) => void;
    const spec = this.execHandler?.(command, options) ?? FakeClient.defaultExec?.(command, options) ?? { code: 0 };
    if (spec.error) {
      process.nextTick(() => callback(spec.error));
      return this;
    }
    const channel = new FakeChannel();
    this.channels.push(channel);
    process.nextTick(() => callback(null, channel));
    channel.run(spec);
    return this;
  }

  sftp(cb: (err: Error | undefined, sftp?: FakeSftp) => void): this {
    process.nextTick(() => {
      if (this.sftpError) cb(this.sftpError);
      else cb(undefined, (this.sftpImpl ??= new FakeSftp()));
    });
    return this;
  }

  end(): void {
    this.ended = true;
    process.nextTick(() => this.emit('close'));
  }

  /** Simulate an unexpected connection drop. */
  drop(error?: Error): void {
    if (error) this.emit('error', error);
    this.emit('close');
  }
}
