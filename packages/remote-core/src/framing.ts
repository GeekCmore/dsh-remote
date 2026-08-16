/**
 * Newline-delimited framing for the dsh-remote daemon byte stream.
 *
 * Every message on the wire is one line of compact JSON terminated by `\n`.
 * Two kinds of lines share the stream:
 *
 * - plain JSON-RPC 2.0 messages (see jsonrpc.ts), and
 * - data frames for multiplexed channels, distinguished by a
 *   `"$dsh-remote-frame": 1` marker field (see {@link encodeDataFrame}).
 *
 * {@link LineDecoder} reassembles lines across arbitrary chunk boundaries and
 * is UTF-8 safe (multi-byte characters may be split across chunks). A line
 * that grows beyond the configured byte cap aborts decoding with a
 * REMOTE_PROTOCOL_ERROR, since a peer that cannot frame correctly cannot be
 * resynchronized.
 */
import { RemoteError } from './errors.js';

/** Default maximum size of a single framed line, in bytes (8 MiB). */
export const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024;

/** Marker field that distinguishes data frames from plain JSON-RPC messages. */
export const FRAME_MARKER = '$dsh-remote-frame';

const encoder = new TextEncoder();

/** Encode one message as compact JSON followed by a newline. */
export function encodeLine(obj: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(obj) + '\n');
}

/**
 * Callback for lines that fail JSON parsing. When provided, the decoder
 * reports the bad line and continues with the next one; when omitted, the
 * parse error propagates out of {@link LineDecoder.push}.
 */
export type InvalidLineHandler = (rawLine: string, error: unknown) => void;

/**
 * Incremental decoder for newline-delimited JSON. Feed arbitrary byte chunks
 * via {@link push}; each returned value is one parsed line. Blank lines are
 * skipped. Call {@link flush} at end-of-stream: a non-empty trailing fragment
 * means the peer truncated a line and is reported as REMOTE_PROTOCOL_ERROR.
 */
export class LineDecoder {
  /** Maximum accepted line size in bytes. */
  readonly maxLineBytes: number;

  #decoder = new TextDecoder('utf-8');
  #tail = '';
  #lineBytes = 0;
  #onInvalidLine?: InvalidLineHandler;

  constructor(maxLineBytes: number = DEFAULT_MAX_LINE_BYTES, onInvalidLine?: InvalidLineHandler) {
    this.maxLineBytes = maxLineBytes;
    this.#onInvalidLine = onInvalidLine;
  }

  /**
   * Feed a chunk of bytes and return every complete line it finishes,
   * parsed as JSON. Throws RemoteError(REMOTE_PROTOCOL_ERROR) when the
   * current line exceeds {@link maxLineBytes}. JSON parse failures throw
   * unless an {@link InvalidLineHandler} was installed.
   */
  push(chunk: Uint8Array): unknown[] {
    this.#lineBytes += chunk.byteLength;
    if (this.#lineBytes > this.maxLineBytes) {
      throw new RemoteError(
        'REMOTE_PROTOCOL_ERROR',
        `framing line exceeds the ${this.maxLineBytes}-byte limit`,
      );
    }
    this.#tail += this.#decoder.decode(chunk, { stream: true });
    const out: unknown[] = [];
    for (;;) {
      const nl = this.#tail.indexOf('\n');
      if (nl < 0) break;
      const raw = this.#tail.slice(0, nl);
      this.#tail = this.#tail.slice(nl + 1);
      this.#lineBytes = Buffer.byteLength(this.#tail, 'utf8');
      if (raw.trim() === '') continue;
      if (this.#onInvalidLine) {
        try {
          out.push(JSON.parse(raw));
        } catch (err) {
          this.#onInvalidLine(raw, err);
        }
      } else {
        out.push(JSON.parse(raw));
      }
    }
    return out;
  }

  /**
   * Signal end-of-stream. Throws RemoteError(REMOTE_PROTOCOL_ERROR) if a
   * partial line is left unterminated; returns nothing otherwise.
   */
  flush(): void {
    const rest = this.#tail + this.#decoder.decode();
    this.#tail = '';
    this.#lineBytes = 0;
    if (rest.trim() !== '') {
      throw new RemoteError('REMOTE_PROTOCOL_ERROR', 'stream ended with a truncated line');
    }
  }
}

/**
 * One frame of a multiplexed channel. `data` carries `payload` bytes;
 * `end` closes the channel; `error` fails it with `message`. The frame is
 * encoded as a single JSON line with binary payloads in base64 and all
 * control fields ASCII-only, so it flows through the same {@link LineDecoder}
 * as plain JSON-RPC messages.
 */
export interface DataFrame {
  /** Logical channel number this frame belongs to. */
  channel: number;
  /** Frame kind. */
  type: 'data' | 'end' | 'error';
  /** Binary payload for `data` frames. */
  payload?: Uint8Array;
  /** Human-readable failure description for `error` frames. */
  message?: string;
}

/** Encode a {@link DataFrame} as a single framed line. */
export function encodeDataFrame(frame: DataFrame): Uint8Array {
  const obj: Record<string, unknown> = {
    [FRAME_MARKER]: 1,
    channel: frame.channel,
    type: frame.type,
  };
  if (frame.payload !== undefined) obj['payload'] = Buffer.from(frame.payload).toString('base64');
  if (frame.message !== undefined) obj['message'] = frame.message;
  return encodeLine(obj);
}

/** True when a decoded line carries the data-frame marker. */
export function isFrameMessage(obj: unknown): obj is Record<string, unknown> {
  return typeof obj === 'object' && obj !== null && (obj as Record<string, unknown>)[FRAME_MARKER] === 1;
}

/**
 * Decode a parsed line into a {@link DataFrame}. Returns null when the line
 * is not a well-formed `data`/`end`/`error` frame (including plain JSON-RPC
 * messages and unknown frame types such as mux-internal `open` frames).
 */
export function decodeDataFrame(obj: unknown): DataFrame | null {
  if (!isFrameMessage(obj)) return null;
  const channel = obj['channel'];
  const type = obj['type'];
  if (typeof channel !== 'number' || !Number.isInteger(channel) || channel < 0) return null;
  if (type !== 'data' && type !== 'end' && type !== 'error') return null;
  const frame: DataFrame = { channel, type };
  if (typeof obj['payload'] === 'string') {
    frame.payload = new Uint8Array(Buffer.from(obj['payload'], 'base64'));
  }
  if (typeof obj['message'] === 'string') frame.message = obj['message'];
  return frame;
}
