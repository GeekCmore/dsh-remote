/**
 * TransferManager: bulk file transfer endpoints over mux data channels.
 *
 * `transfer.open {direction, remotePath, size?, overwrite?}` reserves a mux
 * channel id and answers `{ channel }`; the frontend then opens that channel
 * (type "file") on the shared mux and the bytes flow:
 *
 * - download: the backend streams the remote file out on the channel
 *   (existence/type are checked at open time, so a missing path fails the
 *   call, not the channel);
 * - upload: incoming chunks go to a same-directory temp file (mode 0600) and
 *   are atomically renamed over the target when the channel ends.
 *
 * v1 has no resume/checkpointing: a broken transfer restarts from scratch.
 * The mux API has no error frame for the receiver side, so mid-stream
 * download failures surface as a truncated channel (the frontend should
 * treat a short read as failure); open-time validation keeps that rare.
 */
import { createReadStream } from 'node:fs';
import { constants, mkdir, open as openFile, rename, rm, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import {
  RemoteError,
  type MuxChannel,
  type TransferOpenParams,
  type TransferOpenResult,
} from '@dsh-remote/core';

/** First channel id handed out for transfers (0 is CONTROL_CHANNEL). */
const FIRST_TRANSFER_CHANNEL = 1000;

interface PendingTransfer {
  readonly params: TransferOpenParams;
  readonly channelId: number;
}

export interface TransferManagerOptions {
  /** Diagnostics hook (stderr in serve). */
  diag?: (message: string) => void;
}

export class TransferManager {
  #pending = new Map<number, PendingTransfer>();
  #nextChannel = FIRST_TRANSFER_CHANNEL;
  #diag: (message: string) => void;

  constructor(options: TransferManagerOptions = {}) {
    this.#diag = options.diag ?? (() => {});
  }

  /** `transfer.open`: validate, reserve a channel id, answer it. */
  async open(params: TransferOpenParams): Promise<TransferOpenResult> {
    if (params.direction === 'download') {
      const info = await stat(params.remotePath).catch((err: unknown) => {
        throw new RemoteError('REMOTE_PROTOCOL_ERROR', `cannot stat "${params.remotePath}": ${errMessage(err)}`);
      });
      if (!info.isFile()) {
        throw new RemoteError('REMOTE_PROTOCOL_ERROR', `"${params.remotePath}" is not a regular file`);
      }
    } else {
      const exists = await stat(params.remotePath).then(() => true, () => false);
      if (exists && params.overwrite !== true) {
        throw new RemoteError(
          'REMOTE_PROTOCOL_ERROR',
          `"${params.remotePath}" exists; pass overwrite: true to replace it`,
        );
      }
      await mkdir(dirname(params.remotePath), { recursive: true });
    }
    const channelId = this.#nextChannel++;
    this.#pending.set(channelId, { params, channelId });
    return { channel: channelId };
  }

  /**
   * Bind an inbound mux channel to a pending transfer (matched by channel
   * id) and run it in the background. Returns false for unknown channels.
   */
  handleChannel(channel: MuxChannel): boolean {
    const pending = this.#pending.get(channel.id);
    if (!pending) return false;
    this.#pending.delete(channel.id);
    if (pending.params.direction === 'download') {
      void this.#runDownload(channel, pending.params.remotePath);
    } else {
      void this.#runUpload(channel, pending.params);
    }
    return true;
  }

  /** Transfers still waiting for their channel (tests/diagnostics). */
  get pendingCount(): number {
    return this.#pending.size;
  }

  async #runDownload(channel: MuxChannel, remotePath: string): Promise<void> {
    try {
      for await (const chunk of createReadStream(remotePath)) {
        channel.write(chunk as Uint8Array);
      }
    } catch (err) {
      // No error frame on the mux receiver side (see module doc): the client
      // sees a truncated stream and must treat that as failure.
      this.#diag(`transfer download of "${remotePath}" failed mid-stream: ${errMessage(err)}`);
    } finally {
      channel.close();
    }
  }

  async #runUpload(channel: MuxChannel, params: TransferOpenParams): Promise<void> {
    const dir = dirname(params.remotePath);
    const tmp = `${dir}/.dsh-remote-upload-${randomBytes(6).toString('hex')}.part`;
    let written = 0;
    try {
      const handle = await openFile(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try {
        for await (const chunk of channel.read) {
          await handle.write(chunk);
          written += chunk.byteLength;
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (params.size !== undefined && params.size !== written) {
        throw new Error(`size mismatch: expected ${params.size} bytes, received ${written}`);
      }
      await rename(tmp, params.remotePath);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      this.#diag(`transfer upload to "${params.remotePath}" failed: ${errMessage(err)}`);
    }
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
