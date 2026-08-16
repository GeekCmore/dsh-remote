/**
 * Transport contracts shared by the dsh-remote live-mode providers.
 *
 * `RemoteTransport` is the narrow surface the fs/subprocess providers build on:
 * an SFTP-like handle for file primitives plus streaming exec channels for
 * everything SFTP cannot express (canonicalization, atomic publish, process
 * wrapper control). This package carries the contract only; the concrete
 * ssh2-backed implementation lives in `@dsh-remote/remote-ssh`.
 */

/** Pseudo-terminal geometry and type for an exec channel. */
export interface PtySpec {
  /** Initial terminal row count. */
  rows: number;
  /** Initial terminal column count. */
  cols: number;
  /** Value of the `TERM` environment variable (e.g. `xterm-256color`). */
  term?: string;
}

/** Options for opening an exec channel. */
export interface ExecOptions {
  /** Remote working directory for the command. */
  cwd?: string;
  /** Extra environment (merged over the remote login environment). */
  env?: Record<string, string>;
  /**
   * Request a pseudo-terminal for the channel. `true` allocates a PTY with
   * the server's defaults; pass a {@link PtySpec} to negotiate the initial
   * window size and `TERM` (maps to the SSH `pty-req` parameters).
   */
  pty?: boolean | PtySpec;
  /** Best-effort cancellation; maps to closing the channel. */
  signal?: AbortSignal;
}

/** How an exec channel's stdout/stderr are delivered to the caller. */
export interface ExecProcess {
  /** Incremental stdout chunks (raw bytes). Ends at EOF. */
  readonly stdout: AsyncIterable<Uint8Array>;
  /** Incremental stderr chunks (raw bytes). Ends at EOF. */
  readonly stderr: AsyncIterable<Uint8Array>;
  /** Write to the process stdin; `end()` closes it. */
  write(data: Uint8Array | string): void;
  /** Close stdin without closing the channel. */
  endStdin(): void;
  /** Resolves once with the exit fact; never rejects on non-zero exit. */
  readonly done: Promise<{ code: number | null; signal?: string }>;
  /** Terminate the remote process (channel close / signal escalation). */
  kill(): Promise<void>;
}

/**
 * Minimal SFTP surface used by the fs provider. Structurally compatible with
 * an ssh2 `SFTPWrapper` (promisified); kept narrow so tests can fake it.
 */
export interface SftpLike {
  stat(path: string): Promise<SftpAttrs>;
  lstat(path: string): Promise<SftpAttrs>;
  readdir(path: string): Promise<SftpDirEntry[]>;
  mkdir(path: string, mode?: number): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  /** Open a readable byte stream for `path`. */
  createReadStream(path: string): AsyncIterable<Uint8Array> & { close(): void };
  /** Open a writable byte stream for `path`; finishes on `close()`. */
  createWriteStream(path: string, mode?: number): SftpWriteStream;
}

export interface SftpAttrs {
  /** Byte size for regular files. */
  size: number;
  mode: number;
  mtime: number;
  atime: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface SftpDirEntry {
  name: string;
  attrs: SftpAttrs;
}

export interface SftpWriteStream {
  write(chunk: Uint8Array): void;
  end(): Promise<void>;
}

/** Thrown by transport operations; `code` distinguishes absence from I/O failure. */
export class TransportError extends Error {
  constructor(
    message: string,
    readonly code: 'NO_SUCH_FILE' | 'PERMISSION_DENIED' | 'NOT_DIRECTORY' | 'IO_ERROR' | 'CONN_LOST',
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'TransportError';
  }
}

/** One live SSH connection to a target: the unit `ctx.remoteHub` hands out. */
export interface RemoteTransport {
  /** Open a streaming exec channel running `command` via the remote shell. */
  exec(command: string, opts?: ExecOptions): Promise<ExecProcess>;
  /** Acquire the SFTP subsystem handle. */
  sftp(): Promise<SftpLike>;
  /** Best-effort remote probe of the login environment (HOME etc.). */
  probeLoginEnv(vars: string[]): Promise<Record<string, string>>;
  /** Close the connection; subsequent operations fail with CONN_LOST. */
  close(): Promise<void>;
}

/** Authentication material for an SSH target. */
export type SshAuth =
  /** Authenticate via the local ssh-agent (`SSH_AUTH_SOCK`). */
  | { type: 'agent' }
  /** Authenticate with a private key file on disk. */
  | { type: 'key'; privateKeyPath: string; passphrase?: string }
  /** Authenticate with a password. */
  | { type: 'password'; password: string };

/** Connection parameters for one SSH target. */
export interface SshTargetConfig {
  host: string;
  port?: number;
  username: string;
  auth: SshAuth;
  /** Handshake timeout in milliseconds (ssh2 `readyTimeout`). */
  readyTimeoutMs?: number;
  /** SSH-level keepalive interval in milliseconds. */
  keepaliveIntervalMs?: number;
}

/** Optional hooks for opening an SSH connection. */
export interface SshConnectHooks {
  /**
   * Verify the server's host key before authentication proceeds.
   *
   * `fingerprint` is the OpenSSH-style SHA-256 fingerprint of the raw host
   * key (base64, padding stripped); `hostKey` is the raw key blob. Returning
   * `false` (or rejecting) aborts the connection.
   */
  hostVerifier?: (fingerprint: string, hostKey: Buffer) => boolean | Promise<boolean>;
}
