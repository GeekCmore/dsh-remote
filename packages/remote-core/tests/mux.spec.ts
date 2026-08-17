import { describe, expect, it } from 'vitest';
import {
  CONTROL_CHANNEL,
  ChannelMux,
  RemoteError,
  encodeDataFrame,
  encodeLine,
  type MuxChannel,
} from '../src/index.js';
import { BytePipe, pipePair, tick } from '@dsh-remote/test-utils';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function makeMuxes() {
  const { aIn, bIn } = pipePair();
  const muxA = new ChannelMux({ send: (line) => bIn.push(line) }, aIn);
  const muxB = new ChannelMux({ send: (line) => aIn.push(line) }, bIn);
  return { muxA, muxB, aIn, bIn };
}

async function take(read: AsyncIterable<Uint8Array>, n: number): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for await (const chunk of read) {
    out.push(chunk);
    if (out.length >= n) break;
  }
  return out;
}

async function drain(read: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for await (const chunk of read) out.push(chunk);
  return out;
}

describe('ChannelMux', () => {
  it('exposes the reserved control channel id', () => {
    expect(CONTROL_CHANNEL).toBe(0);
  });

  it('opens a channel and delivers it to the remote onChannel handler', async () => {
    const { muxA, muxB } = makeMuxes();
    const accepted: MuxChannel[] = [];
    muxB.onChannel((ch) => accepted.push(ch));
    muxA.openChannel(1, 'stdio');
    await tick();
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.id).toBe(1);
    expect(accepted[0]!.type).toBe('stdio');
  });

  it('keeps interleaved data on two channels separate and in order', async () => {
    const { muxA, muxB } = makeMuxes();
    const accepted = new Map<number, MuxChannel>();
    muxB.onChannel((ch) => accepted.set(ch.id, ch));
    const a1 = muxA.openChannel(1, 'stdio');
    const a2 = muxA.openChannel(2, 'file');
    await tick();
    const b1 = accepted.get(1)!;
    const b2 = accepted.get(2)!;

    // Interleave writes; each channel must see only its own chunks, ordered.
    a1.write(encoder.encode('a1-one'));
    a2.write(encoder.encode('a2-one'));
    a1.write(encoder.encode('a1-two'));
    a2.write(encoder.encode('a2-two'));
    a1.write(encoder.encode('a1-three'));

    const [got1, got2] = await Promise.all([take(b1.read, 3), take(b2.read, 2)]);
    expect(got1.map((c) => decoder.decode(c))).toEqual(['a1-one', 'a1-two', 'a1-three']);
    expect(got2.map((c) => decoder.decode(c))).toEqual(['a2-one', 'a2-two']);
  });

  it('supports bidirectional traffic on one channel', async () => {
    const { muxA, muxB } = makeMuxes();
    let bCh!: MuxChannel;
    muxB.onChannel((ch) => {
      bCh = ch;
    });
    const aCh = muxA.openChannel(9, 'pty');
    await tick();
    aCh.write(encoder.encode('from-a'));
    bCh.write(encoder.encode('from-b'));
    const [gotA] = await take(aCh.read, 1);
    const [gotB] = await take(bCh.read, 1);
    expect(decoder.decode(gotA!)).toBe('from-b');
    expect(decoder.decode(gotB!)).toBe('from-a');
  });

  it('propagates close: remote read ends after draining, onClose resolves both sides', async () => {
    const { muxA, muxB } = makeMuxes();
    let bCh!: MuxChannel;
    muxB.onChannel((ch) => {
      bCh = ch;
    });
    const aCh = muxA.openChannel(4, 'stdio');
    await tick();
    aCh.write(encoder.encode('last'));
    aCh.close();
    const chunks = await drain(bCh.read);
    expect(chunks.map((c) => decoder.decode(c))).toEqual(['last']);
    await bCh.onClose;
    await aCh.onClose;
    expect(() => aCh.write(encoder.encode('nope'))).toThrowError(RemoteError);
  });

  it('fails the reader when the remote sends an error frame', async () => {
    const { muxA, aIn } = makeMuxes();
    let aCh!: MuxChannel;
    muxA.onChannel((ch) => {
      aCh = ch;
    });
    aIn.push(encodeLine({ '$dsh-remote-frame': 1, channel: 5, type: 'open', channelType: 'file' }));
    await tick();
    aIn.push(encodeDataFrame({ channel: 5, type: 'error', message: 'disk full' }));
    await expect(drain(aCh.read)).rejects.toMatchObject({
      code: 'REMOTE_PROTOCOL_ERROR',
      message: 'disk full',
    });
    await aCh.onClose;
  });

  it('bounds unread payload bytes without discarding already accepted data', async () => {
    const { aIn, bIn } = pipePair();
    const sender = new ChannelMux({ send: (line) => bIn.push(line) }, aIn);
    const receiver = new ChannelMux({ send: (line) => aIn.push(line) }, bIn, {
      maxQueuedBytes: 5,
    });
    let remote!: MuxChannel;
    receiver.onChannel((channel) => {
      remote = channel;
    });
    const local = sender.openChannel(7, 'file');
    await tick();
    local.write(encoder.encode('abc'));
    local.write(encoder.encode('def'));
    await remote.onClose;
    const iterator = remote.read[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({
      value: encoder.encode('abc'),
      done: false,
    });
    await expect(iterator.next()).rejects.toMatchObject({
      code: 'REMOTE_PROTOCOL_ERROR',
      message: expect.stringContaining('exceeded 5 queued bytes'),
    });
    await local.onClose;
  });

  it('rejects duplicate local channel ids', async () => {
    const { muxA } = makeMuxes();
    muxA.openChannel(1, 'stdio');
    expect(() => muxA.openChannel(1, 'pty')).toThrowError(/already open/);
    await tick();
  });

  it('fails all channel readers with REMOTE_CONN_LOST when the stream dies', async () => {
    const { muxA, muxB, bIn } = makeMuxes();
    let bCh!: MuxChannel;
    muxB.onChannel((ch) => {
      bCh = ch;
    });
    const aCh = muxA.openChannel(1, 'stdio');
    await tick();
    bIn.end(); // B's inbound ends => B's mux tears down; also end A's side.
    await expect(drain(bCh.read)).rejects.toMatchObject({ code: 'REMOTE_CONN_LOST' });
    await muxB.closed;
    void aCh;
  });
});
