/**
 * ssh2-backed implementation of the {@link RemoteTransport} contract.
 *
 * One `SshTransport` owns one ssh2 `Client` per target. Exec channels run
 * through the remote user's shell (ssh2 `exec` is shell-semantics: the
 * command string is interpreted by the remote shell, so quoting/argv
 * assembly is the caller's responsibility). SFTP is exposed through the
 * narrow {@link SftpLike} surface.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client } from 'ssh2';
import type {
  ClientChannel,
  ConnectConfig,
  FileEntryWithStats,
  KeyboardInteractiveCallback,
  Prompt,
  SFTPWrapper,
  Stats,
} from 'ssh2';
import {
  TransportError,
  type ExecOptions,
  type ExecProcess,
  type RemoteTransport,
  type SftpAttrs,
  type SftpDirEntry,
  type SftpLike,
  type SftpWriteStream,
  type SshConnectHooks,
  type SshTargetConfig,
} from '@dsh-remote/remote';

export type { SshAuth, SshConnectHooks, SshTargetConfig } from '@dsh-remote/remote';

/** Quote a value for interpolation into a remote shell command line. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Assemble the final command line for an exec channel. ssh2 `exec` already
 * runs the command through the remote shell; we only layer `cwd`/`env`
 * plumbing on top. Anything in `command` itself is the caller's quoting
 * responsibility.
 */
function buildCommand(command: string, opts: ExecOptions): string {
  let line = command;
  if (opts.env) {
    const assignments = Object.entries(opts.env).map(([key, value]) => `${key}=${shQuote(value)}`);
    if (assignments.length) line = `${assignments.join(' ')} ${line}`;
  }
  if (opts.cwd) line = `cd ${shQuote(opts.cwd)} && ${line}`;
  return line;
}

/**
 * Translate the contract's `pty` option into an ssh2 exec `pty` value.
 * A {@link PtySpec} maps to the `pty-req` window size and `TERM`.
 */
function toSsh2Pty(pty: ExecOptions['pty']): boolean | { rows: number; cols: number; term: string } {
  if (pty === undefined || pty === false) return false;
  if (pty === true) return true;
  return { rows: pty.rows, cols: pty.cols, term: pty.term ?? 'xterm-256color' };
}

/** Map an SFTP failure to a {@link TransportError} per the contract codes. */
function mapSftpError(err: unknown, what: string, gone: boolean): TransportError {
  if (gone) {
    return new TransportError(`connection lost during ${what}`, 'CONN_LOST', { cause: err });
  }
  const code = (err as { code?: number } | undefined)?.code;
  const message = err instanceof Error ? err.message : String(err);
  if (code === 2) return new TransportError(`${what}: ${message}`, 'NO_SUCH_FILE', { cause: err });
  if (code === 3) return new TransportError(`${what}: ${message}`, 'PERMISSION_DENIED', { cause: err });
  return new TransportError(`${what}: ${message}`, 'IO_ERROR', { cause: err });
}

/** Adapt an ssh2 `Stats` record to the contract's {@link SftpAttrs}. */
function toAttrs(stats: Stats): SftpAttrs {
  return stats;
}

/** {@link SftpLike} adapter over an ssh2 `SFTPWrapper`. */
class SshSftp implements SftpLike {
  constructor(
    private readonly raw: SFTPWrapper,
    private readonly isGone: () => boolean,
  ) {}

  private guard(what: string): void {
    if (this.isGone()) throw new TransportError(`connection lost: cannot ${what}`, 'CONN_LOST');
  }

  /** Promisify one SFTP operation with uniform error mapping. */
  private call<T>(what: string, run: (cb: (err: Error | undefined, result: T) => void) => void): Promise<T> {
    this.guard(what);
    return new Promise<T>((resolve, reject) => {
      run((err, result) => {
        if (err) reject(mapSftpError(err, what, this.isGone()));
        else resolve(result);
      });
    });
  }

  /** Same as {@link call} for void-valued operations. */
  private callVoid(what: string, run: (cb: (err?: Error | null) => void) => void): Promise<void> {
    this.guard(what);
    return new Promise<void>((resolve, reject) => {
      run((err) => {
        if (err) reject(mapSftpError(err, what, this.isGone()));
        else resolve();
      });
    });
  }

  async stat(path: string): Promise<SftpAttrs> {
    return toAttrs(await this.call<Stats>(`stat ${path}`, (cb) => this.raw.stat(path, cb)));
  }

  async lstat(path: string): Promise<SftpAttrs> {
    return toAttrs(await this.call<Stats>(`lstat ${path}`, (cb) => this.raw.lstat(path, cb)));
  }

  async readdir(path: string): Promise<SftpDirEntry[]> {
    const list = await this.call<FileEntryWithStats[]>(`readdir ${path}`, (cb) => this.raw.readdir(path, cb));
    return list.map((entry) => ({ name: entry.filename, attrs: toAttrs(entry.attrs) }));
  }

  async mkdir(path: string, mode?: number): Promise<void> {
    await this.callVoid(`mkdir ${path}`, (cb) =>
      mode === undefined ? this.raw.mkdir(path, cb) : this.raw.mkdir(path, { mode }, cb));
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await this.callVoid(`rename ${oldPath} ${newPath}`, (cb) => this.raw.rename(oldPath, newPath, cb));
  }

  async unlink(path: string): Promise<void> {
    await this.callVoid(`unlink ${path}`, (cb) => this.raw.unlink(path, cb));
  }

  async rmdir(path: string): Promise<void> {
    await this.callVoid(`rmdir ${path}`, (cb) => this.raw.rmdir(path, cb));
  }

  createReadStream(path: string): AsyncIterable<Uint8Array> & { close(): void } {
    this.guard(`read ${path}`);
    const stream = this.raw.createReadStream(path);
    return {
      [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator]() as AsyncIterator<Uint8Array>,
      close(): void {
        stream.close(() => {});
      },
    };
  }

  createWriteStream(path: string, mode?: number): SftpWriteStream {
    this.guard(`write ${path}`);
    const stream = mode === undefined
      ? this.raw.createWriteStream(path)
      : this.raw.createWriteStream(path, { mode });
    return {
      write(chunk: Uint8Array): void {
        stream.write(chunk);
      },
      end(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
          stream.once('error', reject);
          stream.once('close', () => resolve());
          stream.end();
        });
      },
    };
  }
}

/**
 * One live SSH connection to a target.
 *
 * Construct via {@link SshTransport.connect}. After `close()` or an
 * unexpected disconnect, every operation fails with `CONN_LOST`; consumers
 * observe the latter through {@link SshTransport.onUnexpectedClose}.
 */
export class SshTransport implements RemoteTransport {
  /** Called once when the connection drops without `close()` being invoked. */
  onUnexpectedClose?: (error?: Error) => void;

  private gone = false;
  private closing = false;
  private closeEmitted = false;
  private closePromise?: Promise<void>;
  private lastError?: Error;
  private sftpCache?: SftpLike;
  private resolveGone!: () => void;
  private readonly untilGone: Promise<void>;

  private constructor(private readonly client: Client) {
    this.untilGone = new Promise<void>((resolve) => {
      this.resolveGone = resolve;
    });
    // ssh2 re-emits socket errors on the client; without a persistent
    // listener EventEmitter would throw them as unhandled.
    client.on('error', (err: Error) => {
      this.lastError = err;
    });
    client.on('close', () => {
      this.closeEmitted = true;
      this.markGone();
      if (!this.closing) this.onUnexpectedClose?.(this.lastError);
    });
  }

  /**
   * Open a connection to an SSH target.
   *
   * Rejects with a `TransportError` (`IO_ERROR`) on handshake/auth failure
   * or timeout, or when the `hostVerifier` hook rejects the host key.
   */
  static async connect(config: SshTargetConfig, hooks?: SshConnectHooks): Promise<SshTransport> {
    const client = new Client();
    const transport = new SshTransport(client);
    const options = await SshTransport.buildConnectConfig(config, hooks);
    let keyboardPassword = config.auth.type === 'password' ? config.auth.password : undefined;
    const onKeyboardInteractive = (
      _name: string,
      _instructions: string,
      _lang: string,
      prompts: Prompt[],
      finish: KeyboardInteractiveCallback,
    ) => {
      const password = keyboardPassword;
      finish(password === undefined ? [] : prompts.map(() => password));
    };
    const removeKeyboardInteractiveListener = () => {
      const off = client.off as unknown as (event: string, listener: typeof onKeyboardInteractive) => Client;
      off.call(client, 'keyboard-interactive', onKeyboardInteractive);
    };
    if (keyboardPassword !== undefined) client.on('keyboard-interactive', onKeyboardInteractive);
    await new Promise<void>((resolve, reject) => {
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        client.off('ready', onReady);
        client.off('error', onError);
        removeKeyboardInteractiveListener();
        keyboardPassword = undefined;
        if (config.auth.type === 'password') options.password = undefined;
      };
      client.once('ready', onReady);
      client.once('error', onError);
      client.connect(options);
    }).catch(async (err: unknown) => {
      transport.closing = true;
      transport.markGone();
      client.end();
      const message = err instanceof Error ? err.message : String(err);
      throw new TransportError(`failed to connect to ${config.host}:${config.port ?? 22}: ${message}`, 'IO_ERROR', { cause: err });
    });
    return transport;
  }

  /** Translate {@link SshTargetConfig} into ssh2 `ConnectConfig`. */
  private static async buildConnectConfig(config: SshTargetConfig, hooks?: SshConnectHooks): Promise<ConnectConfig> {
    const options: ConnectConfig = {
      host: config.host,
      port: config.port ?? 22,
      username: config.username,
      readyTimeout: config.readyTimeoutMs,
      keepaliveInterval: config.keepaliveIntervalMs,
    };
    switch (config.auth.type) {
      case 'agent':
        options.agent = process.env.SSH_AUTH_SOCK;
        break;
      case 'key':
        options.privateKey = await readFile(config.auth.privateKeyPath);
        if (config.auth.passphrase !== undefined) options.passphrase = config.auth.passphrase;
        break;
      case 'password':
        options.password = config.auth.password;
        options.tryKeyboard = true;
        break;
    }
    if (hooks?.hostVerifier) {
      const verify = hooks.hostVerifier;
      // Without `hostHash`, ssh2 hands us the raw host key; we compute the
      // OpenSSH-style SHA-256 fingerprint ourselves.
      options.hostVerifier = (hostKey: Buffer, done: (valid: boolean) => void) => {
        const fingerprint = createHash('sha256').update(hostKey).digest('base64').replace(/=+$/, '');
        Promise.resolve(verify(fingerprint, hostKey)).then(
          (valid) => done(valid),
          () => done(false),
        );
      };
    }
    return options;
  }

  /** Throw `CONN_LOST` once the connection is closed or dropped. */
  private assertUsable(what: string): void {
    if (this.gone || this.closing) {
      throw new TransportError(`connection lost: cannot ${what}`, 'CONN_LOST');
    }
  }

  private markGone(): void {
    this.gone = true;
    this.resolveGone();
  }

  async exec(command: string, opts: ExecOptions = {}): Promise<ExecProcess> {
    this.assertUsable('exec');
    const channel = await new Promise<ClientChannel>((resolve, reject) => {
      this.client.exec(buildCommand(command, opts), { pty: toSsh2Pty(opts.pty) }, (err, ch) => {
        if (err) reject(err);
        else resolve(ch);
      });
    }).catch((err: unknown) => {
      if (this.gone) throw new TransportError('connection lost: cannot exec', 'CONN_LOST', { cause: err });
      const message = err instanceof Error ? err.message : String(err);
      throw new TransportError(`failed to open exec channel: ${message}`, 'IO_ERROR', { cause: err });
    });
    return this.adoptChannel(channel, opts.signal);
  }

  /** Wrap a live exec channel as an {@link ExecProcess}. */
  private adoptChannel(channel: ClientChannel, signal?: AbortSignal): ExecProcess {
    let resolveDone!: (result: { code: number | null; signal?: string }) => void;
    let settled = false;
    // `done` never rejects: a non-zero exit is a fact, not an exception.
    const done = new Promise<{ code: number | null; signal?: string }>((resolve) => {
      resolveDone = (result) => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };
    });
    channel.once('close', (code: number | null, sig?: string) => {
      resolveDone(sig ? { code: code ?? null, signal: sig } : { code: code ?? null });
    });
    channel.once('error', () => {
      resolveDone({ code: null });
    });

    const kill = (): Promise<void> => {
      channel.close();
      // `close` should always follow, but race against connection loss so a
      // dead connection cannot hang the caller.
      return Promise.race([done, this.untilGone]).then(() => undefined);
    };

    if (signal) {
      if (signal.aborted) {
        queueMicrotask(() => void kill());
      } else {
        signal.addEventListener('abort', () => void kill(), { once: true });
      }
    }

    return {
      stdout: channel,
      stderr: channel.stderr,
      write(data: Uint8Array | string): void {
        channel.write(data);
      },
      endStdin(): void {
        channel.end();
      },
      done,
      kill,
    };
  }

  async sftp(): Promise<SftpLike> {
    this.assertUsable('open SFTP subsystem');
    if (this.sftpCache) return this.sftpCache;
    const raw = await new Promise<SFTPWrapper>((resolve, reject) => {
      this.client.sftp((err, sftpWrapper) => {
        if (err) reject(err);
        else resolve(sftpWrapper);
      });
    }).catch((err: unknown) => {
      if (this.gone) throw new TransportError('connection lost: cannot open SFTP subsystem', 'CONN_LOST', { cause: err });
      const message = err instanceof Error ? err.message : String(err);
      throw new TransportError(`failed to open SFTP subsystem: ${message}`, 'IO_ERROR', { cause: err });
    });
    this.sftpCache = new SshSftp(raw, () => this.gone || this.closing);
    return this.sftpCache;
  }

  async probeLoginEnv(vars: string[]): Promise<Record<string, string>> {
    if (!vars.length) return {};
    for (const name of vars) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new TypeError(`invalid environment variable name: ${name}`);
      }
    }
    // Read-only probe; any failure degrades to an empty environment rather
    // than breaking the caller's flow.
    try {
      const command = `printf '%s\\0' ${vars.map((name) => `"$${name}"`).join(' ')}`;
      const proc = await this.exec(command);
      const chunks: Uint8Array[] = [];
      for await (const chunk of proc.stdout) chunks.push(chunk);
      const { code } = await proc.done;
      if (code !== 0) return {};
      const parts = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8').split('\0');
      const env: Record<string, string> = {};
      vars.forEach((name, index) => {
        env[name] = parts[index] ?? '';
      });
      return env;
    } catch {
      return {};
    }
  }

  /** Idempotent; subsequent operations fail with `CONN_LOST`. */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.markGone();
    this.closePromise = this.closeEmitted
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          this.client.once('close', () => resolve());
          this.client.end();
        });
    return this.closePromise;
  }
}
