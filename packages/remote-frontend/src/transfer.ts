/**
 * `ctx.remoteTransfer`: local↔remote file copy plus bounded remote preview.
 *
 * The remote side goes through the injected `FileSystem` seam (in live mode an
 * `SshFileSystem` from `@dsh-remote/fs-ssh`) for identity/metadata, and through
 * the target's `RemoteTransport` SFTP handle for the byte stream — never
 * `streamText`, so binary payloads survive without UTF-8 decoding.
 *
 * KEY PITFALL: the LOCAL side deliberately uses `node:fs` and never `ctx.fs`.
 * In live mode `ctx.fs` already points at the remote host, so writing a local
 * destination through the seam would write it back to the remote machine.
 */
import { createReadStream } from 'node:fs';
import { lstat, open, rename, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { Context, Service } from '@deepseek-ai/cordis';
import { FsError } from '@dsh-remote/seams';
import type { FileSystem, FsInfo } from '@dsh-remote/seams';
import type { RemoteTransport, SftpLike } from '@dsh-remote/remote';

declare module '@deepseek-ai/cordis' {
  interface Context {
    remoteTransfer: RemoteTransfer;
  }

  interface Events {
    /** One emit per copied chunk while a transfer is in flight. */
    'remote/transfer-progress'(progress: TransferProgress): void;
  }
}

export type TransferDirection = 'download' | 'upload';

/** One progress datapoint: cumulative bytes copied so far. */
export interface TransferProgress {
  targetId: string;
  direction: TransferDirection;
  sourcePath: string;
  destPath: string;
  /** Cumulative bytes copied so far. */
  bytes: number;
  /** Total byte size when known up front (regular files). */
  total?: number;
}

export interface TransferOptions {
  /** Allow replacing an existing destination file; otherwise the copy fails. */
  overwrite?: boolean;
  /** Best-effort cancellation; staged partial output is cleaned up. */
  signal?: AbortSignal;
  /** Called after every written chunk with cumulative bytes and known total. */
  onProgress?: (bytes: number, total?: number) => void;
}

export interface TransferResult {
  bytes: number;
  sourcePath: string;
  destPath: string;
  durationMs: number;
}

export interface PreviewResult {
  /** UTF-8 decoded prefix of the remote file. */
  text: string;
  /** True when the file exceeds `maxBytes` and `text` is a prefix. */
  truncated: boolean;
  /** Full byte size of the remote file (when the backend can report it). */
  size: number;
}

/** Construction options for {@link RemoteTransfer}. */
export interface RemoteTransferOptions {
  /**
   * The remote filesystem for a target (provided by fs-ssh in the host).
   * `undefined` means no live session for that target.
   */
  getRemoteFs(targetId: string): FileSystem | undefined;
  /**
   * The live transport for a target, used for the SFTP byte stream.
   * `undefined` means the target is disconnected.
   */
  getTransport(targetId: string): RemoteTransport | undefined;
}

/** Extract a `TransportError`-shaped code without an instanceof link to one class. */
function transportCode(e: unknown): string | undefined {
  if (e instanceof Error && e.name === 'TransportError' && 'code' in e) {
    return (e as { code: string }).code;
  }
  return undefined;
}

/** Map transport and local-fs failures onto the seam's error taxonomy. */
function mapTransferError(e: unknown, what: string): FsError {
  if (e instanceof FsError) return e;
  const tcode = transportCode(e);
  const ncode = (e as NodeJS.ErrnoException | undefined)?.code;
  const message = e instanceof Error ? e.message : String(e);
  if (tcode === 'NO_SUCH_FILE' || ncode === 'ENOENT') {
    return new FsError(`${what}: no such file (${message})`, 'FS_NOT_FOUND', { cause: e });
  }
  if (tcode === 'PERMISSION_DENIED' || ncode === 'EACCES' || ncode === 'EPERM') {
    return new FsError(`${what}: permission denied (${message})`, 'FS_PERMISSION_DENIED', {
      cause: e,
    });
  }
  if (tcode === 'NOT_DIRECTORY' || ncode === 'ENOTDIR') {
    return new FsError(`${what}: not a directory (${message})`, 'FS_NOT_DIRECTORY', { cause: e });
  }
  return new FsError(`${what}: I/O failure (${message})`, 'FS_IO_ERROR', { cause: e });
}

/** Best-effort cancellation: throw `FS_ABORTED` when the signal has fired. */
function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new FsError('transfer aborted', 'FS_ABORTED', { cause: signal.reason });
  }
}

async function writeFully(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(chunk, offset);
    if (bytesWritten === 0) {
      throw new FsError('local write made no progress', 'FS_IO_ERROR');
    }
    offset += bytesWritten;
  }
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export class RemoteTransfer extends Service {
  private readonly options: RemoteTransferOptions;

  constructor(ctx: Context, options: RemoteTransferOptions) {
    super(ctx, 'remoteTransfer');
    this.options = options;
  }

  /**
   * Copy a regular file from a remote target to a local path. The local file
   * is written atomically: staged as `<localPath>.dsh-remote-tmp-<rand>` with
   * mode 0600, chmod'd to 0644, then published with a same-directory rename.
   */
  async copyRemoteToLocal(
    targetId: string,
    remotePath: string,
    localPath: string,
    opts: TransferOptions = {},
  ): Promise<TransferResult> {
    const started = Date.now();
    checkAborted(opts.signal);
    const fs = this.remoteFs(targetId);
    const target = await fs.resolve(remotePath, { signal: opts.signal });
    const info = await fs.stat(target, opts.signal);
    if (!info) throw new FsError(`no such file: ${remotePath}`, 'FS_NOT_FOUND');
    if (info.type !== 'file') {
      throw new FsError(`not a regular file: ${remotePath}`, 'FS_NOT_REGULAR_FILE');
    }
    await this.assertLocalDestination(localPath, opts.overwrite);

    const sftp = await this.sftp(targetId);
    const stream = sftp.createReadStream(fs.processPath(target));
    const tmp = `${localPath}.dsh-remote-tmp-${randomBytes(6).toString('hex')}`;
    let bytes = 0;
    try {
      const handle = await open(tmp, 'wx', 0o600).catch((e: unknown) => {
        throw mapTransferError(e, `stage ${localPath}`);
      });
      try {
        // Backpressure: each chunk is awaited against the local disk before
        // the next SFTP chunk is pulled.
        for await (const chunk of stream) {
          checkAborted(opts.signal);
          await writeFully(handle, chunk);
          bytes += chunk.length;
          this.report(targetId, 'download', remotePath, localPath, bytes, info.size, opts);
        }
        checkAborted(opts.signal);
        await handle.chmod(0o644);
      } finally {
        await handle.close();
      }
      await rename(tmp, localPath).catch((e: unknown) => {
        throw mapTransferError(e, `publish ${localPath}`);
      });
    } catch (e) {
      stream.close();
      await rm(tmp, { force: true }).catch(() => {});
      throw mapTransferError(e, `copy ${remotePath}`);
    }
    return { bytes, sourcePath: remotePath, destPath: localPath, durationMs: Date.now() - started };
  }

  /**
   * Copy a local regular file to a remote target. The remote destination is
   * written directly through SFTP (mode 0644); when the destination did not
   * exist beforehand, a failed or aborted copy best-effort removes the
   * partial remote file.
   */
  async copyLocalToRemote(
    targetId: string,
    localPath: string,
    remotePath: string,
    opts: TransferOptions = {},
  ): Promise<TransferResult> {
    const started = Date.now();
    checkAborted(opts.signal);
    // Local source via node:fs — NOT ctx.fs (see module header).
    const st = await lstat(localPath).catch((e: unknown) => {
      throw mapTransferError(e, `stat ${localPath}`);
    });
    if (!st.isFile()) {
      throw new FsError(`not a regular file: ${localPath}`, 'FS_NOT_REGULAR_FILE');
    }
    const fs = this.remoteFs(targetId);
    const target = await fs.resolve(remotePath, { signal: opts.signal });
    const info = await fs.stat(target, opts.signal);
    if (info) {
      if (info.type !== 'file') {
        throw new FsError(`not a regular file: ${remotePath}`, 'FS_NOT_REGULAR_FILE');
      }
      if (!opts.overwrite) {
        throw new FsError(
          `destination exists (pass overwrite to replace): ${remotePath}`,
          'FS_NOT_OBSERVED',
        );
      }
    }

    const sftp = await this.sftp(targetId);
    const ws = sftp.createWriteStream(fs.processPath(target), 0o644);
    let bytes = 0;
    try {
      for await (const chunk of createReadStream(localPath)) {
        checkAborted(opts.signal);
        ws.write(chunk as Uint8Array);
        bytes += (chunk as Uint8Array).length;
        this.report(targetId, 'upload', localPath, remotePath, bytes, st.size, opts);
      }
      checkAborted(opts.signal);
      await ws.end();
    } catch (e) {
      if (!info) {
        await sftp.unlink(fs.processPath(target)).catch(() => {});
      }
      throw mapTransferError(e, `copy ${localPath}`);
    }
    return { bytes, sourcePath: localPath, destPath: remotePath, durationMs: Date.now() - started };
  }

  /**
   * Bounded read of a remote text file for UI preview. At most `maxBytes` are
   * pulled; binary content (NUL probe) is rejected with `FS_NOT_TEXT`, and an
   * oversized file returns its prefix with `truncated: true`.
   */
  async preview(targetId: string, remotePath: string, maxBytes: number): Promise<PreviewResult> {
    const fs = this.remoteFs(targetId);
    const target = await fs.resolve(remotePath);
    const info = await fs.stat(target);
    if (!info) throw new FsError(`no such file: ${remotePath}`, 'FS_NOT_FOUND');
    if (info.type !== 'file') {
      throw new FsError(`not a regular file: ${remotePath}`, 'FS_NOT_REGULAR_FILE');
    }
    const sftp = await this.sftp(targetId);
    const stream = sftp.createReadStream(fs.processPath(target));
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    try {
      for await (const chunk of stream) {
        if (total + chunk.length > maxBytes) {
          chunks.push(chunk.slice(0, maxBytes - total));
          total = maxBytes;
          truncated = true;
          break;
        }
        chunks.push(chunk);
        total += chunk.length;
      }
    } catch (e) {
      throw mapTransferError(e, `read ${remotePath}`);
    } finally {
      stream.close();
    }
    if (info.size !== undefined && info.size > maxBytes) truncated = true;
    const bytes = concatBytes(chunks);
    if (bytes.indexOf(0) !== -1) {
      throw new FsError(`binary content rejected: ${remotePath}`, 'FS_NOT_TEXT');
    }
    return {
      text: new TextDecoder('utf-8').decode(bytes),
      truncated,
      size: info.size ?? total,
    };
  }

  // -------------------------------------------------------------- private

  private remoteFs(targetId: string): FileSystem {
    const fs = this.options.getRemoteFs(targetId);
    if (!fs) {
      throw new FsError(`no remote filesystem for target: ${targetId}`, 'FS_IO_ERROR', {
        cause: new Error('remote session unavailable: connection down or not yet established'),
      });
    }
    return fs;
  }

  private async sftp(targetId: string): Promise<SftpLike> {
    const transport = this.options.getTransport(targetId);
    if (!transport) {
      throw new FsError(`no live connection for target: ${targetId}`, 'FS_IO_ERROR', {
        cause: new Error('remote transport unavailable: connection down or not yet established'),
      });
    }
    try {
      return await transport.sftp();
    } catch (e) {
      throw mapTransferError(e, 'acquire sftp');
    }
  }

  private async assertLocalDestination(
    localPath: string,
    overwrite: boolean | undefined,
  ): Promise<void> {
    let st;
    try {
      st = await lstat(localPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw mapTransferError(e, `stat ${localPath}`);
    }
    if (st.isDirectory()) {
      throw new FsError(`not a regular file: ${localPath}`, 'FS_NOT_REGULAR_FILE');
    }
    if (!overwrite) {
      throw new FsError(
        `destination exists (pass overwrite to replace): ${localPath}`,
        'FS_NOT_OBSERVED',
      );
    }
  }

  private report(
    targetId: string,
    direction: TransferDirection,
    sourcePath: string,
    destPath: string,
    bytes: number,
    total: number | undefined,
    opts: TransferOptions,
  ): void {
    opts.onProgress?.(bytes, total);
    this.ctx.emit('remote/transfer-progress', {
      targetId,
      direction,
      sourcePath,
      destPath,
      bytes,
      total,
    });
  }
}

export default RemoteTransfer;
