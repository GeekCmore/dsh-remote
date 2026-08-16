import { mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { FsError } from '@dsh-remote/seams';
import { SshFileSystem } from '@dsh-remote/fs-ssh';
import { RemoteTransfer } from '../src/transfer.js';
import type { TransferProgress } from '../src/transfer.js';
import { FakeTransport } from './fake-transport.js';

function setup(readChunkSize = 1024) {
  const ctx = new Context();
  const fake = new FakeTransport({ readChunkSize });
  const fs = new SshFileSystem(ctx, { getTransport: () => fake });
  const transfer = new RemoteTransfer(ctx, {
    getRemoteFs: () => fs,
    getTransport: () => fake,
  });
  const progressEvents: TransferProgress[] = [];
  ctx.on('remote/transfer-progress', (p) => progressEvents.push(p));
  return { ctx, fake, fs, transfer, progressEvents };
}

async function tmp() {
  return mkdtemp(join(tmpdir(), 'dsh-remote-frontend-'));
}

async function expectFsError(p: Promise<unknown>, code: string): Promise<void> {
  await expect(p).rejects.toBeInstanceOf(FsError);
  await expect(p).rejects.toMatchObject({ code });
}

describe('copyRemoteToLocal', () => {
  it('copies a text file byte-for-byte', async () => {
    const { fake, transfer } = setup();
    const dir = await tmp();
    fake.mkdir('/work');
    fake.writeFile('/work/hello.txt', 'héllo wörld\n');
    const dest = join(dir, 'hello.txt');
    const result = await transfer.copyRemoteToLocal('t1', '/work/hello.txt', dest);
    expect(await readFile(dest, 'utf8')).toBe('héllo wörld\n');
    expect(result.bytes).toBe(14);
    expect(result.sourcePath).toBe('/work/hello.txt');
    expect(result.destPath).toBe(dest);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('copies binary content without UTF-8 decoding damage', async () => {
    const { fake, transfer } = setup();
    const dir = await tmp();
    fake.mkdir('/work');
    const payload = new Uint8Array(4096);
    for (let i = 0; i < payload.length; i++) payload[i] = i % 256; // includes 0x00 and 0xff
    fake.writeFile('/work/blob.bin', payload);
    const dest = join(dir, 'blob.bin');
    const result = await transfer.copyRemoteToLocal('t1', '/work/blob.bin', dest);
    expect(result.bytes).toBe(4096);
    expect(new Uint8Array(await readFile(dest))).toEqual(payload);
  });

  it('reports chunked progress via callback and event with a known total', async () => {
    const { fake, transfer, progressEvents } = setup(1024);
    const dir = await tmp();
    fake.mkdir('/work');
    fake.writeFile('/work/big.txt', 'x'.repeat(10_000));
    const callback: Array<[number, number | undefined]> = [];
    const dest = join(dir, 'big.txt');
    const result = await transfer.copyRemoteToLocal('t1', '/work/big.txt', dest, {
      onProgress: (bytes, total) => callback.push([bytes, total]),
    });
    expect(result.bytes).toBe(10_000);
    // ceil(10000/1024) = 10 chunks.
    expect(callback.length).toBe(10);
    expect(progressEvents.length).toBe(10);
    expect(callback[0]).toEqual([1024, 10_000]);
    expect(callback[callback.length - 1]).toEqual([10_000, 10_000]);
    const last = progressEvents[progressEvents.length - 1]!;
    expect(last).toMatchObject({
      targetId: 't1',
      direction: 'download',
      bytes: 10_000,
      total: 10_000,
    });
  });

  it('produces a regular local file with mode 0644 and no staging leftovers', async () => {
    const { fake, transfer } = setup();
    const dir = await tmp();
    fake.mkdir('/work');
    fake.writeFile('/work/a.txt', 'a');
    const dest = join(dir, 'a.txt');
    await transfer.copyRemoteToLocal('t1', '/work/a.txt', dest);
    expect((await stat(dest)).mode & 0o777).toBe(0o644);
    expect(await readdir(dir)).toEqual(['a.txt']);
  });

  it('refuses to overwrite an existing local file without overwrite: true', async () => {
    const { fake, transfer } = setup();
    const dir = await tmp();
    fake.mkdir('/work');
    fake.writeFile('/work/a.txt', 'remote');
    const dest = join(dir, 'a.txt');
    await writeFile(dest, 'local');
    await expectFsError(transfer.copyRemoteToLocal('t1', '/work/a.txt', dest), 'FS_NOT_OBSERVED');
    expect(await readFile(dest, 'utf8')).toBe('local');
    await transfer.copyRemoteToLocal('t1', '/work/a.txt', dest, { overwrite: true });
    expect(await readFile(dest, 'utf8')).toBe('remote');
  });

  it('rejects a local directory as destination', async () => {
    const { fake, transfer } = setup();
    const dir = await tmp();
    fake.mkdir('/work');
    fake.writeFile('/work/a.txt', 'x');
    await expectFsError(transfer.copyRemoteToLocal('t1', '/work/a.txt', dir), 'FS_NOT_REGULAR_FILE');
  });

  it('maps a missing remote source to FS_NOT_FOUND and a directory to FS_NOT_REGULAR_FILE', async () => {
    const { fake, transfer } = setup();
    const dir = await tmp();
    fake.mkdir('/work/dir');
    await expectFsError(
      transfer.copyRemoteToLocal('t1', '/work/missing.txt', join(dir, 'x')),
      'FS_NOT_FOUND',
    );
    await expectFsError(
      transfer.copyRemoteToLocal('t1', '/work/dir', join(dir, 'x')),
      'FS_NOT_REGULAR_FILE',
    );
  });

  it('fails when no remote filesystem is available for the target', async () => {
    const ctx = new Context();
    const transfer = new RemoteTransfer(ctx, {
      getRemoteFs: () => undefined,
      getTransport: () => undefined,
    });
    await expectFsError(
      transfer.copyRemoteToLocal('nope', '/work/a.txt', '/tmp/never'),
      'FS_IO_ERROR',
    );
  });

  it('aborts mid-stream: FS_ABORTED, no destination, staging file cleaned up', async () => {
    const { fake, transfer } = setup(512);
    const dir = await tmp();
    fake.mkdir('/work');
    fake.writeFile('/work/big.txt', 'x'.repeat(10_000));
    const controller = new AbortController();
    const dest = join(dir, 'big.txt');
    const promise = transfer.copyRemoteToLocal('t1', '/work/big.txt', dest, {
      signal: controller.signal,
      onProgress: () => controller.abort(),
    });
    await expectFsError(promise, 'FS_ABORTED');
    // Destination never appeared and the staging temp file was removed.
    expect(await readdir(dir)).toEqual([]);
  });

  it('maps a lost connection to FS_IO_ERROR', async () => {
    const { fake, transfer } = setup();
    const dir = await tmp();
    fake.mkdir('/work');
    fake.writeFile('/work/a.txt', 'a');
    await fake.close();
    await expectFsError(
      transfer.copyRemoteToLocal('t1', '/work/a.txt', join(dir, 'a.txt')),
      'FS_IO_ERROR',
    );
  });
});

describe('copyLocalToRemote', () => {
  it('uploads a text file and reports progress with the local size as total', async () => {
    const { fake, transfer, progressEvents } = setup();
    const dir = await tmp();
    fake.mkdir('/work');
    const src = join(dir, 'note.txt');
    await writeFile(src, 'local note\n');
    const result = await transfer.copyLocalToRemote('t1', src, '/work/note.txt');
    expect(new TextDecoder().decode(fake.readFile('/work/note.txt'))).toBe('local note\n');
    expect(result.bytes).toBe(11);
    expect(progressEvents.length).toBeGreaterThan(0);
    expect(progressEvents[progressEvents.length - 1]).toMatchObject({
      targetId: 't1',
      direction: 'upload',
      bytes: 11,
      total: 11,
    });
  });

  it('uploads binary content byte-for-byte', async () => {
    const { fake, transfer } = setup();
    const dir = await tmp();
    fake.mkdir('/work');
    const payload = new Uint8Array(2048);
    for (let i = 0; i < payload.length; i++) payload[i] = 255 - (i % 256);
    const src = join(dir, 'blob.bin');
    await writeFile(src, payload);
    await transfer.copyLocalToRemote('t1', src, '/work/blob.bin');
    expect(fake.readFile('/work/blob.bin')).toEqual(payload);
  });

  it('refuses to overwrite an existing remote file without overwrite: true', async () => {
    const { fake, transfer } = setup();
    const dir = await tmp();
    fake.mkdir('/work');
    fake.writeFile('/work/a.txt', 'remote');
    const src = join(dir, 'a.txt');
    await writeFile(src, 'local');
    await expectFsError(transfer.copyLocalToRemote('t1', src, '/work/a.txt'), 'FS_NOT_OBSERVED');
    expect(new TextDecoder().decode(fake.readFile('/work/a.txt'))).toBe('remote');
    await transfer.copyLocalToRemote('t1', src, '/work/a.txt', { overwrite: true });
    expect(new TextDecoder().decode(fake.readFile('/work/a.txt'))).toBe('local');
  });

  it('maps a missing local source to FS_NOT_FOUND and a local directory to FS_NOT_REGULAR_FILE', async () => {
    const { fake, transfer } = setup();
    const dir = await tmp();
    fake.mkdir('/work');
    await expectFsError(
      transfer.copyLocalToRemote('t1', join(dir, 'missing'), '/work/x'),
      'FS_NOT_FOUND',
    );
    await expectFsError(transfer.copyLocalToRemote('t1', dir, '/work/x'), 'FS_NOT_REGULAR_FILE');
  });

  it('rejects a remote directory as destination', async () => {
    const { fake, transfer } = setup();
    const dir = await tmp();
    fake.mkdir('/work/dir');
    const src = join(dir, 'a.txt');
    await writeFile(src, 'x');
    await expectFsError(transfer.copyLocalToRemote('t1', src, '/work/dir'), 'FS_NOT_REGULAR_FILE');
  });

  it('aborts before publication and removes the partial remote file it created', async () => {
    const { fake, transfer } = setup();
    const dir = await tmp();
    fake.mkdir('/work');
    const src = join(dir, 'big.txt');
    await writeFile(src, 'y'.repeat(100_000));
    const controller = new AbortController();
    controller.abort();
    await expectFsError(
      transfer.copyLocalToRemote('t1', src, '/work/big.txt', { signal: controller.signal }),
      'FS_ABORTED',
    );
    expect(fake.exists('/work/big.txt')).toBe(false);
  });
});

describe('preview', () => {
  it('returns the full text of a small file', async () => {
    const { fake, transfer } = setup();
    fake.mkdir('/work');
    fake.writeFile('/work/small.txt', 'hello\n');
    const result = await transfer.preview('t1', '/work/small.txt', 1024);
    expect(result).toEqual({ text: 'hello\n', truncated: false, size: 6 });
  });

  it('returns a truncated prefix for files larger than maxBytes', async () => {
    const { fake, transfer } = setup();
    fake.mkdir('/work');
    fake.writeFile('/work/big.txt', 'abcdefghijklmnopqrstuvwxyz');
    const result = await transfer.preview('t1', '/work/big.txt', 10);
    expect(result.text).toBe('abcdefghij');
    expect(result.truncated).toBe(true);
    expect(result.size).toBe(26);
  });

  it('rejects binary content with FS_NOT_TEXT', async () => {
    const { fake, transfer } = setup();
    fake.mkdir('/work');
    fake.writeFile('/work/bin.dat', new Uint8Array([0x41, 0x00, 0x42]));
    await expectFsError(transfer.preview('t1', '/work/bin.dat', 1024), 'FS_NOT_TEXT');
  });

  it('maps a missing file to FS_NOT_FOUND', async () => {
    const { fake, transfer } = setup();
    fake.mkdir('/work');
    await expectFsError(transfer.preview('t1', '/work/nope.txt', 1024), 'FS_NOT_FOUND');
  });
});
