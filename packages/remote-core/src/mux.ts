/**
 * Logical channel multiplexing over a single byte stream.
 *
 * One SSH connection carries the daemon control channel plus an arbitrary
 * number of stdio/PTY/file-transfer data channels. Frames are encoded with
 * the data-frame helpers from framing.ts, so a mux can share its byte stream
 * with a {@link JsonRpcPeer}: each layer ignores the other's lines.
 *
 * Channel lifecycle: the opener sends an `open` frame (a mux-internal frame
 * kind carrying the channel type), then both sides exchange `data` frames;
 * either side ends the channel with an `end` frame, and `error` frames fail
 * it. Channel ids are caller-assigned; the mux only rejects duplicates on
 * its own side. Channel {@link CONTROL_CHANNEL} is reserved for the daemon
 * control channel by convention and is not special-cased here.
 *
 * Backpressure (v1, deliberately simple): `write` never blocks or paces —
 * frames go straight to the outbound hook. The read side buffers per-channel
 * and delivers chunks in arrival order, so a slow consumer only grows its own
 * channel's queue. Flow control (windowing) is left for a later revision.
 */
import { RemoteError } from './errors.js';
import {
  FRAME_MARKER,
  LineDecoder,
  decodeDataFrame,
  encodeDataFrame,
  encodeLine,
  isFrameMessage,
  type DataFrame,
} from './framing.js';

/** Default unread payload budget for one logical channel (64 MiB). */
export const DEFAULT_MAX_QUEUED_BYTES = 64 * 1024 * 1024;

export interface ChannelMuxOptions {
  /** Maximum unread payload bytes buffered per channel. */
  maxQueuedBytes?: number;
}

/** Channel id reserved for the daemon control channel (JSON-RPC). */
export const CONTROL_CHANNEL = 0;

/** One logical channel of a {@link ChannelMux}. */
export interface MuxChannel {
  /** Channel id, as assigned by the opener. */
  readonly id: number;
  /** Opaque channel type string chosen by the opener (e.g. "stdio", "pty", "file"). */
  readonly type: string;
  /**
   * Ordered stream of chunks sent by the remote side. Ends cleanly on a
   * remote `end` frame (or local {@link close}); throws a RemoteError on a
   * remote `error` frame or when the underlying byte stream dies.
   */
  readonly read: AsyncIterable<Uint8Array>;
  /** Send one chunk to the remote side. Throws once the channel is closed. */
  write(chunk: Uint8Array): void;
  /** Send an `end` frame and close the channel locally. Idempotent. */
  close(): void;
  /** Resolves when the channel has ended, for any reason. Never rejects. */
  readonly onClose: Promise<void>;
}

type PullWaiter = {
  resolve: (r: IteratorResult<Uint8Array>) => void;
  reject: (e: unknown) => void;
};

class MuxChannelImpl implements MuxChannel {
  readonly id: number;
  readonly type: string;
  readonly read: AsyncIterable<Uint8Array>;
  readonly onClose: Promise<void>;

  #sendFrame: (frame: DataFrame) => void;
  #queue: Uint8Array[] = [];
  #queuedBytes = 0;
  #maxQueuedBytes: number;
  #waiter: PullWaiter | null = null;
  #end: 'open' | 'done' | RemoteError = 'open';
  #resolveClose!: () => void;

  constructor(
    id: number,
    type: string,
    sendFrame: (frame: DataFrame) => void,
    maxQueuedBytes: number,
  ) {
    this.id = id;
    this.type = type;
    this.#sendFrame = sendFrame;
    this.#maxQueuedBytes = maxQueuedBytes;
    this.onClose = new Promise((resolve) => {
      this.#resolveClose = resolve;
    });
    this.read = { [Symbol.asyncIterator]: () => this.#iterate() };
  }

  write(chunk: Uint8Array): void {
    if (this.#end !== 'open') {
      throw new RemoteError('REMOTE_CONN_LOST', `channel ${this.id} is closed`);
    }
    this.#sendFrame({ channel: this.id, type: 'data', payload: chunk });
  }

  close(): void {
    if (this.#end !== 'open') return;
    this.#sendFrame({ channel: this.id, type: 'end' });
    this._finish('done');
  }

  /** Deliver a remote `data` payload. */
  _data(payload: Uint8Array): void {
    if (this.#end !== 'open') return;
    if (this.#waiter) {
      const waiter = this.#waiter;
      this.#waiter = null;
      waiter.resolve({ value: payload, done: false });
    } else {
      if (this.#queuedBytes + payload.byteLength > this.#maxQueuedBytes) {
        const message = `channel ${this.id} exceeded ${this.#maxQueuedBytes} queued bytes`;
        this.#sendFrame({ channel: this.id, type: 'error', message });
        this._finish(new RemoteError('REMOTE_PROTOCOL_ERROR', message));
        return;
      }
      this.#queue.push(payload);
      this.#queuedBytes += payload.byteLength;
    }
  }

  /** Terminate the channel; queued chunks are still delivered before the end/error surfaces. */
  _finish(end: 'done' | RemoteError): void {
    if (this.#end !== 'open') return;
    this.#end = end;
    this.#drainWaiter();
    this.#resolveClose();
  }

  #drainWaiter(): void {
    if (!this.#waiter) return;
    const waiter = this.#waiter;
    this.#waiter = null;
    if (this.#queue.length > 0) {
      const value = this.#queue.shift()!;
      this.#queuedBytes -= value.byteLength;
      waiter.resolve({ value, done: false });
    } else if (this.#end instanceof RemoteError) {
      waiter.reject(this.#end);
    } else {
      waiter.resolve({ value: undefined, done: true });
    }
  }

  #pull(): Promise<IteratorResult<Uint8Array>> {
    if (this.#queue.length > 0) {
      const value = this.#queue.shift()!;
      this.#queuedBytes -= value.byteLength;
      return Promise.resolve({ value, done: false });
    }
    if (this.#end instanceof RemoteError) return Promise.reject(this.#end);
    if (this.#end === 'done') return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => {
      this.#waiter = { resolve, reject };
    });
  }

  async *#iterate(): AsyncGenerator<Uint8Array> {
    for (;;) {
      const next = await this.#pull();
      if (next.done) return;
      yield next.value;
    }
  }
}

/** Output hook the mux writes encoded frame lines to. */
export interface MuxOutbound {
  send(line: Uint8Array): void;
}

interface OpenFrame {
  channel: number;
  channelType: string;
}

function encodeOpenFrame(channel: number, channelType: string): Uint8Array {
  return encodeLine({ [FRAME_MARKER]: 1, channel, type: 'open', channelType });
}

function decodeOpenFrame(obj: unknown): OpenFrame | null {
  if (!isFrameMessage(obj)) return null;
  if (obj['type'] !== 'open') return null;
  const channel = obj['channel'];
  if (typeof channel !== 'number' || !Number.isInteger(channel) || channel < 0) return null;
  const channelType = obj['channelType'];
  return { channel, channelType: typeof channelType === 'string' ? channelType : 'data' };
}

/**
 * Multiplexes logical channels over one newline-framed byte stream. Consumes
 * `inbound` in the background; when the stream ends or fails, every open
 * channel's reader fails with REMOTE_CONN_LOST and {@link closed} resolves.
 * Frames for unknown or already-closed channels, undecodable lines, and
 * non-frame lines (e.g. control JSON-RPC on a shared stream) are ignored.
 */
export class ChannelMux {
  #out: MuxOutbound;
  #channels = new Map<number, MuxChannelImpl>();
  #handler: ((ch: MuxChannel) => void) | undefined;
  // Malformed lines on a mux stream are dropped; there is no peer to answer.
  #decoder = new LineDecoder(undefined, () => {});
  #closed: Promise<void>;
  #resolveClosed!: () => void;
  #maxQueuedBytes: number;

  constructor(
    outbound: MuxOutbound,
    inbound: AsyncIterable<Uint8Array>,
    options: ChannelMuxOptions = {},
  ) {
    this.#out = outbound;
    this.#maxQueuedBytes = options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES;
    if (!Number.isSafeInteger(this.#maxQueuedBytes) || this.#maxQueuedBytes < 0) {
      throw new TypeError('ChannelMux maxQueuedBytes must be a non-negative safe integer');
    }
    this.#closed = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
    void this.#pump(inbound);
  }

  /** Resolves once the inbound stream has ended and all channels were torn down. */
  get closed(): Promise<void> {
    return this.#closed;
  }

  /**
   * Open a channel towards the remote peer: sends the `open` frame and
   * returns the local endpoint. Throws REMOTE_PROTOCOL_ERROR when `id` is
   * invalid or already in use locally.
   */
  openChannel(id: number, type: string): MuxChannel {
    if (!Number.isInteger(id) || id < 0) {
      throw new RemoteError('REMOTE_PROTOCOL_ERROR', `invalid channel id ${String(id)}`);
    }
    if (this.#channels.has(id)) {
      throw new RemoteError('REMOTE_PROTOCOL_ERROR', `channel ${id} is already open`);
    }
    this.#out.send(encodeOpenFrame(id, type));
    return this.#create(id, type);
  }

  /**
   * Register the handler invoked for channels opened by the remote peer.
   * Only applies to channels opened after registration.
   */
  onChannel(handler: (ch: MuxChannel) => void): void {
    this.#handler = handler;
  }

  #create(id: number, type: string): MuxChannelImpl {
    const ch = new MuxChannelImpl(
      id,
      type,
      (frame) => this.#out.send(encodeDataFrame(frame)),
      this.#maxQueuedBytes,
    );
    this.#channels.set(id, ch);
    void ch.onClose.then(() => {
      if (this.#channels.get(id) === ch) this.#channels.delete(id);
    });
    return ch;
  }

  async #pump(inbound: AsyncIterable<Uint8Array>): Promise<void> {
    try {
      for await (const chunk of inbound) {
        for (const msg of this.#decoder.push(chunk)) {
          this.#handleLine(msg);
        }
      }
    } catch {
      // Framing failure (e.g. oversized line): tear everything down below.
    }
    const err = new RemoteError('REMOTE_CONN_LOST', 'mux byte stream ended');
    for (const ch of this.#channels.values()) ch._finish(err);
    this.#channels.clear();
    this.#resolveClosed();
  }

  #handleLine(msg: unknown): void {
    const open = decodeOpenFrame(msg);
    if (open) {
      if (!this.#channels.has(open.channel)) {
        const ch = this.#create(open.channel, open.channelType);
        this.#handler?.(ch);
      }
      return;
    }
    const frame = decodeDataFrame(msg);
    if (!frame) return;
    const ch = this.#channels.get(frame.channel);
    if (!ch) return;
    if (frame.type === 'data') {
      ch._data(frame.payload ?? new Uint8Array(0));
    } else if (frame.type === 'end') {
      ch._finish('done');
    } else {
      ch._finish(
        new RemoteError('REMOTE_PROTOCOL_ERROR', frame.message ?? `channel ${frame.channel} failed`),
      );
    }
  }
}
