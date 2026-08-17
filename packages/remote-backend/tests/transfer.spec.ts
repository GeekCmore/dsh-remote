import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Methods, type TransferOpenResult } from '@dsh-remote/core';
import { TEST_TOKEN, expectRemoteError, handshake, makeWorld } from './fakes.js';
import { sleep } from '@dsh-remote/test-utils';

async function waitFor(cond: () => Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await sleep(20);
  }
  throw new Error('condition not met in time');
}

describe('transfer over the mux', () => {
  it('downloads a remote file end to end', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-backend-dl-'));
    const path = join(dir, 'hello.txt');
    const content = Buffer.from('hello remote world\n'.repeat(5000)); // ~95 KiB, multiple chunks
    await writeFile(path, content);

    const world = makeWorld();
    await handshake(world.client, TEST_TOKEN);
    const { channel } = (await world.client.call(Methods.TransferOpen, {
      direction: 'download',
      remotePath: path,
    })) as TransferOpenResult;
    expect(channel).toBeGreaterThan(0);

    const ch = world.clientMux.openChannel(channel, 'file');
    const parts: Uint8Array[] = [];
    for await (const chunk of ch.read) parts.push(chunk);
    expect(Buffer.concat(parts.map((p) => Buffer.from(p)))).toEqual(content);
  });

  it('fails download of a missing file at open time', async () => {
    const world = makeWorld();
    await handshake(world.client, TEST_TOKEN);
    await expectRemoteError(
      world.client.call(Methods.TransferOpen, {
        direction: 'download',
        remotePath: '/nonexistent/definitely-missing.bin',
      }),
      'REMOTE_PROTOCOL_ERROR',
    );
  });

  it('uploads atomically (temp file + rename), honoring overwrite and size', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-backend-ul-'));
    const path = join(dir, 'sub', 'upload.bin');
    const content = Buffer.alloc(100_000, 7);

    const world = makeWorld();
    await handshake(world.client, TEST_TOKEN);
    const { channel } = (await world.client.call(Methods.TransferOpen, {
      direction: 'upload',
      remotePath: path,
      size: content.byteLength,
    })) as TransferOpenResult;

    const ch = world.clientMux.openChannel(channel, 'file');
    // Send in awkward chunk sizes to exercise reassembly on the write side.
    for (let off = 0; off < content.byteLength; off += 33_333) {
      ch.write(new Uint8Array(content.subarray(off, off + 33_333)));
    }
    ch.close();

    await waitFor(async () => (await readFile(path).catch(() => null)) !== null);
    expect(await readFile(path)).toEqual(content);
    // No temp files left behind.
    const leftovers = (await readdir(join(dir, 'sub'))).filter((n) => n.includes('.part'));
    expect(leftovers).toEqual([]);

    // Second upload without overwrite is refused at open time.
    await expectRemoteError(
      world.client.call(Methods.TransferOpen, { direction: 'upload', remotePath: path }),
      'REMOTE_PROTOCOL_ERROR',
    );
  });

  it('drops uploads whose declared size does not match', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-backend-ul2-'));
    const path = join(dir, 'size.bin');
    const world = makeWorld();
    await handshake(world.client, TEST_TOKEN);
    const { channel } = (await world.client.call(Methods.TransferOpen, {
      direction: 'upload',
      remotePath: path,
      size: 10,
    })) as TransferOpenResult;
    const ch = world.clientMux.openChannel(channel, 'file');
    ch.write(new Uint8Array(20)); // 20 bytes against a declared 10
    ch.close();
    await waitFor(async () => world.diags.some((d) => d.includes('size mismatch')));
    await expect(readFile(path)).rejects.toThrow();
  });
});
