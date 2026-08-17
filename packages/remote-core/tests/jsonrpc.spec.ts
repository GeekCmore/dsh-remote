import { describe, expect, it } from 'vitest';
import { JsonRpcPeer, RemoteError, encodeLine } from '../src/index.js';
import { BytePipe, decodeLines, pipePair, tick } from '@dsh-remote/test-utils';

function makePeers() {
  const { aIn, bIn } = pipePair();
  const a = new JsonRpcPeer({ send: (line) => bIn.push(line) }, aIn);
  const b = new JsonRpcPeer({ send: (line) => aIn.push(line) }, bIn);
  return { a, b, aIn, bIn };
}

describe('JsonRpcPeer', () => {
  it('completes a call round-trip with params and result', async () => {
    const { a, b } = makePeers();
    b.on('add', (params) => {
      const { x, y } = params as { x: number; y: number };
      return x + y;
    });
    await expect(a.call('add', { x: 2, y: 40 })).resolves.toBe(42);
  });

  it('supports concurrent calls matched by id', async () => {
    const { a, b } = makePeers();
    b.on('double', (params) => (params as { n: number }).n * 2);
    const [r1, r2, r3] = await Promise.all([
      a.call('double', { n: 1 }),
      a.call('double', { n: 2 }),
      a.call('double', { n: 3 }),
    ]);
    expect([r1, r2, r3]).toEqual([2, 4, 6]);
  });

  it('delivers notifications in both directions', async () => {
    const { a, b } = makePeers();
    const seenByB = new Promise<unknown>((resolve) => b.onNotification('ping', resolve));
    const seenByA = new Promise<unknown>((resolve) => a.onNotification('pong', resolve));
    a.notify('ping', { seq: 1 });
    b.notify('pong', { seq: 2 });
    await expect(seenByB).resolves.toEqual({ seq: 1 });
    await expect(seenByA).resolves.toEqual({ seq: 2 });
  });

  it('maps -32601 (unknown method) to REMOTE_PROTOCOL_ERROR with the server message', async () => {
    const { a } = makePeers();
    const err = await a.call('no.such.method').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteError);
    expect((err as RemoteError).code).toBe('REMOTE_PROTOCOL_ERROR');
    expect((err as RemoteError).message).toContain('method not found: no.such.method');
  });

  it('maps a throwing handler to -32603 preserving the message', async () => {
    const { a, b } = makePeers();
    b.on('boom', () => {
      throw new Error('kaput');
    });
    const err = await a.call('boom').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteError);
    expect((err as RemoteError).code).toBe('REMOTE_PROTOCOL_ERROR');
    expect((err as RemoteError).message).toContain('kaput');
  });

  it('round-trips a RemoteError thrown by the handler with its code and data', async () => {
    const { a, b } = makePeers();
    b.on('attach', () => {
      throw new RemoteError('REMOTE_SESSION_LOCKED', 'session is controlled elsewhere', {
        data: { holder: 'client-9', attachedAt: '2026-08-16T00:00:00Z' },
      });
    });
    const err = await a.call('attach').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteError);
    expect((err as RemoteError).code).toBe('REMOTE_SESSION_LOCKED');
    expect((err as RemoteError).message).toBe('session is controlled elsewhere');
    expect((err as RemoteError).data).toEqual({
      holder: 'client-9',
      attachedAt: '2026-08-16T00:00:00Z',
    });
  });

  it('aborts a pending call with REMOTE_ABORTED and sends $/cancel', async () => {
    const { a, b } = makePeers();
    b.on('hang', () => new Promise(() => {}));
    const cancelSeen = new Promise<unknown>((resolve) => b.onNotification('$/cancel', resolve));
    const ac = new AbortController();
    const pending = a.call('hang', undefined, ac.signal);
    ac.abort();
    await expect(pending).rejects.toMatchObject({ code: 'REMOTE_ABORTED' });
    await expect(cancelSeen).resolves.toEqual({ id: 1 });
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const { a } = makePeers();
    const ac = new AbortController();
    ac.abort();
    await expect(a.call('anything', undefined, ac.signal)).rejects.toMatchObject({
      code: 'REMOTE_ABORTED',
    });
  });

  it('times out a pending call, sends $/cancel and ignores the late response', async () => {
    const inbound = new BytePipe();
    const sent: Uint8Array[] = [];
    const peer = new JsonRpcPeer({ send: (line) => sent.push(line) }, inbound, {
      requestTimeoutMs: 5,
    });
    await expect(peer.call('hang')).rejects.toMatchObject({ code: 'REMOTE_TIMEOUT' });
    expect(decodeLines(sent)).toEqual([
      { jsonrpc: '2.0', id: 1, method: 'hang' },
      { jsonrpc: '2.0', method: '$/cancel', params: { id: 1 } },
    ]);
    inbound.push(encodeLine({ jsonrpc: '2.0', id: 1, result: 'late' }));
    await tick();
    expect(decodeLines(sent)).toHaveLength(2);
    inbound.end();
    await peer.closed;
  });

  it('rejects all pending calls with REMOTE_CONN_LOST when the stream ends', async () => {
    const { a, b, aIn } = makePeers();
    b.on('hang', () => new Promise(() => {}));
    const p1 = a.call('hang');
    const p2 = a.call('hang');
    await tick();
    aIn.end(); // the remote side went away
    await expect(p1).rejects.toMatchObject({ code: 'REMOTE_CONN_LOST' });
    await expect(p2).rejects.toMatchObject({ code: 'REMOTE_CONN_LOST' });
    await a.closed;
  });

  it('ignores a response with an unknown id', async () => {
    const received: Uint8Array[] = [];
    const inbound = new BytePipe();
    const peer = new JsonRpcPeer({ send: (line) => received.push(line) }, inbound);
    inbound.push(encodeLine({ jsonrpc: '2.0', id: 999, result: 'late' }));
    await tick();
    expect(received).toEqual([]);
    inbound.end();
    await peer.closed;
  });

  it('answers unparseable lines with -32700 and keeps working', async () => {
    const received: Uint8Array[] = [];
    const inbound = new BytePipe();
    const peer = new JsonRpcPeer({ send: (line) => received.push(line) }, inbound);
    peer.on('ok', () => 'fine');
    inbound.push(new TextEncoder().encode('this is not json\n'));
    await tick();
    const msgs = decodeLines(received) as { id: unknown; error: { code: number } }[];
    expect(msgs[0]!.id).toBeNull();
    expect(msgs[0]!.error.code).toBe(-32700);
    // The peer is still functional afterwards.
    inbound.push(encodeLine({ jsonrpc: '2.0', id: 5, method: 'ok' }));
    await tick();
    const msgs2 = decodeLines(received) as { id: unknown; result?: string }[];
    expect(msgs2[1]).toEqual({ jsonrpc: '2.0', id: 5, result: 'fine' });
    inbound.end();
    await peer.closed;
  });

  it('answers non-JSON-RPC objects with -32600', async () => {
    const received: Uint8Array[] = [];
    const inbound = new BytePipe();
    const peer = new JsonRpcPeer({ send: (line) => received.push(line) }, inbound);
    inbound.push(encodeLine({ hello: 'world' }));
    await tick();
    const msgs = decodeLines(received) as { id: unknown; error: { code: number } }[];
    expect(msgs[0]!.id).toBeNull();
    expect(msgs[0]!.error.code).toBe(-32600);
    inbound.end();
    await peer.closed;
  });

  it('ignores data-frame lines so it can share a stream with a mux', async () => {
    const received: Uint8Array[] = [];
    const inbound = new BytePipe();
    const peer = new JsonRpcPeer({ send: (line) => received.push(line) }, inbound);
    inbound.push(encodeLine({ '$dsh-remote-frame': 1, channel: 3, type: 'end' }));
    await tick();
    expect(received).toEqual([]);
    inbound.end();
    await peer.closed;
  });
});
