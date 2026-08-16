/**
 * Local reassembly of the wrapper's base64 frame transport, plus the bounded
 * tail reader backing collect-mode streams. Ported from the upstream
 * subprocess-e2b adapter (E2BBase64Decoder / E2BOutputReader), adapted to the
 * two-stream SSH channel layout (control frames live on channel stdout only).
 */
import { Buffer } from 'node:buffer';
import type { SubprocessOutputRead, SubprocessOutputReader } from '@dsh-remote/seams';

const BASE64_LINE = /^[A-Za-z0-9+/]+={0,2}$/;

export type ControlHandler = (line: string) => void;

/**
 * Incrementally decode one channel stream of newline-delimited frames.
 *
 * Lines are reassembled across arbitrary chunk boundaries. A line starting
 * with `!` is a control frame handed to `onControl`; a pure base64 line
 * decodes to stream bytes; anything else (only possible before the encoders
 * start, e.g. `env: 'x': No such file or directory` from the remote shell) is
 * routed to `onDiagnostic` so spawn failures can quote it.
 */
export class FrameDecoder {
  private pending = '';

  constructor(
    private readonly onControl: ControlHandler | undefined,
    private readonly onDiagnostic: ((line: string) => void) | undefined,
  ) {}

  /** Decode every complete frame in one arbitrarily split chunk. */
  push(text: string): Buffer {
    if (text.length === 0) return Buffer.alloc(0);
    this.pending += text;
    const decoded: Buffer[] = [];
    for (;;) {
      const boundary = this.pending.indexOf('\n');
      if (boundary < 0) break;
      let frame = this.pending.slice(0, boundary);
      this.pending = this.pending.slice(boundary + 1);
      if (frame.endsWith('\r')) frame = frame.slice(0, -1);
      if (frame.length === 0) continue;
      if (frame.startsWith('!')) {
        this.onControl?.(frame);
        continue;
      }
      if (!BASE64_LINE.test(frame)) {
        this.onDiagnostic?.(frame);
        continue;
      }
      const bytes = Buffer.from(frame, 'base64');
      if (bytes.toString('base64') !== frame) {
        throw new Error('subprocess-ssh: invalid base64 output transport');
      }
      decoded.push(bytes);
    }
    return Buffer.concat(decoded);
  }

  /**
   * Validate a clean encoder EOF. After requested termination or a drain
   * cutoff (`requireComplete === false`) a trailing partial frame is simply
   * discarded.
   */
  finish(requireComplete = true): void {
    if (!requireComplete) {
      this.pending = '';
      return;
    }
    if (this.pending.trim().length > 0) {
      throw new Error('subprocess-ssh: truncated base64 output transport');
    }
  }
}

/**
 * Bounded in-memory tail of one collected stream with whole-stream offset
 * reads; the remote spill path is advertised only while the spill file is
 * known to hold the complete stream.
 */
export class TailOutputReader implements SubprocessOutputReader {
  private chunks: Buffer[] = [];
  private retainedBytes = 0;
  private totalBytes = 0;
  private spillValid = true;

  constructor(
    private readonly maxBytes: number,
    private readonly maxSpillBytes: number | undefined,
    private readonly spillPath: () => string,
  ) {}

  /** Total bytes observed from the channel stream. */
  get size(): number {
    return this.totalBytes;
  }

  /** Stop advertising a spill whose writer did not reach clean EOF. */
  invalidateSpill(): void {
    this.spillValid = false;
  }

  /** Append decoded stream bytes, dropping the head beyond the tail cap. */
  push(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    const chunk = Buffer.from(bytes);
    this.totalBytes += chunk.length;
    this.chunks.push(chunk);
    this.retainedBytes += chunk.length;
    while (this.retainedBytes > this.maxBytes) {
      const head = this.chunks[0]!;
      const excess = this.retainedBytes - this.maxBytes;
      if (head.length <= excess) {
        this.chunks.shift();
        this.retainedBytes -= head.length;
      } else {
        this.chunks[0] = head.subarray(excess);
        this.retainedBytes -= excess;
      }
    }
  }

  /** @inheritdoc */
  readFrom(fromByte: number): SubprocessOutputRead {
    const retained = Buffer.concat(this.chunks, this.retainedBytes);
    const firstRetained = this.totalBytes - this.retainedBytes;
    const lossy = fromByte < firstRetained;
    const start = lossy ? 0 : Math.min(retained.length, Math.max(0, fromByte - firstRetained));
    return {
      text: retained.subarray(start).toString('utf8'),
      nextOffset: this.totalBytes,
      lossy,
      ...(lossy && this.spillValid && this.maxSpillBytes !== undefined && this.totalBytes <= this.maxSpillBytes
        ? { spillPath: this.spillPath() }
        : {}),
    };
  }
}
