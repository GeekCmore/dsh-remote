import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_LINE_BYTES,
  LineDecoder,
  RemoteError,
  decodeDataFrame,
  encodeDataFrame,
  encodeLine,
} from '../src/index.js';

const encoder = new TextEncoder();

describe('encodeLine / LineDecoder', () => {
  it('round-trips several objects packed into one chunk', () => {
    const a = { hello: 'world' };
    const b = { n: 42, nested: { x: [1, 2, 3] } };
    const decoder = new LineDecoder();
    const chunk = new Uint8Array([...encodeLine(a), ...encodeLine(b)]);
    expect(decoder.push(chunk)).toEqual([a, b]);
  });

  it('reassembles a line split across chunks', () => {
    const line = encodeLine({ a: 1, b: 'two' });
    const decoder = new LineDecoder();
    expect(decoder.push(line.subarray(0, 5))).toEqual([]);
    expect(decoder.push(line.subarray(5))).toEqual([{ a: 1, b: 'two' }]);
  });

  it('is UTF-8 safe when multi-byte characters are cut across chunks', () => {
    const obj = { text: 'héllo 中文 🚀 end' };
    const line = encodeLine(obj);
    const decoder = new LineDecoder();
    // Feed one byte at a time: every multi-byte sequence is split somewhere.
    const out: unknown[] = [];
    for (const byte of line) {
      out.push(...decoder.push(new Uint8Array([byte])));
    }
    expect(out).toEqual([obj]);
  });

  it('skips blank lines', () => {
    const decoder = new LineDecoder();
    const chunk = new Uint8Array([...encoder.encode('\n  \n'), ...encodeLine({ ok: true })]);
    expect(decoder.push(chunk)).toEqual([{ ok: true }]);
  });

  it('throws REMOTE_PROTOCOL_ERROR when a line exceeds the byte cap', () => {
    const decoder = new LineDecoder(16);
    const big = encodeLine({ pad: 'x'.repeat(64) });
    expect(() => decoder.push(big)).toThrowError(RemoteError);
    expect(() => new LineDecoder(16).push(big)).toThrowError(/exceeds/);
    try {
      new LineDecoder(16).push(big);
    } catch (err) {
      expect((err as RemoteError).code).toBe('REMOTE_PROTOCOL_ERROR');
    }
  });

  it('applies the cap across chunk boundaries, not per chunk', () => {
    const decoder = new LineDecoder(10);
    decoder.push(encoder.encode('{"a":"'));
    expect(() => decoder.push(encoder.encode('12345678901234567890'))).toThrowError(RemoteError);
  });

  it('flush() throws on a truncated trailing line and passes on a clean end', () => {
    const dirty = new LineDecoder();
    dirty.push(encoder.encode('{"partial":'));
    expect(() => dirty.flush()).toThrowError(/truncated/);

    const clean = new LineDecoder();
    clean.push(encodeLine({ done: true }));
    expect(() => clean.flush()).not.toThrow();
  });

  it('reports invalid JSON via the invalid-line handler and keeps going', () => {
    const bad: string[] = [];
    const decoder = new LineDecoder(DEFAULT_MAX_LINE_BYTES, (raw) => bad.push(raw));
    const chunk = new Uint8Array([...encoder.encode('not json\n'), ...encodeLine({ ok: 1 })]);
    expect(decoder.push(chunk)).toEqual([{ ok: 1 }]);
    expect(bad).toEqual(['not json']);
  });

  it('throws invalid JSON from push() when no handler is installed', () => {
    const decoder = new LineDecoder();
    expect(() => decoder.push(encoder.encode('{oops\n'))).toThrowError(SyntaxError);
  });
});

describe('data frames', () => {
  it('round-trips a data frame with a binary payload', () => {
    const payload = new Uint8Array([0, 1, 2, 250, 255]);
    const frame = { channel: 7, type: 'data' as const, payload };
    const decoded = new LineDecoder().push(encodeDataFrame(frame));
    expect(decoded).toHaveLength(1);
    const back = decodeDataFrame(decoded[0]);
    expect(back).not.toBeNull();
    expect(back!.channel).toBe(7);
    expect(back!.type).toBe('data');
    expect([...back!.payload!]).toEqual([0, 1, 2, 250, 255]);
  });

  it('round-trips end and error frames', () => {
    const decoder = new LineDecoder();
    const [endMsg] = decoder.push(encodeDataFrame({ channel: 1, type: 'end' }));
    expect(decodeDataFrame(endMsg)).toEqual({ channel: 1, type: 'end' });
    const [errMsg] = decoder.push(encodeDataFrame({ channel: 1, type: 'error', message: 'boom' }));
    expect(decodeDataFrame(errMsg)).toEqual({ channel: 1, type: 'error', message: 'boom' });
  });

  it('returns null for plain JSON-RPC messages and unknown frame types', () => {
    expect(decodeDataFrame({ jsonrpc: '2.0', id: 1, method: 'x' })).toBeNull();
    expect(decodeDataFrame({ '$dsh-remote-frame': 1, channel: 1, type: 'open' })).toBeNull();
    expect(decodeDataFrame(null)).toBeNull();
    expect(decodeDataFrame('str')).toBeNull();
  });
});
