/**
 * M1 end-to-end integration test: real sshd (Alpine container, key auth) →
 * SshTransport → SshRemoteHub (ctx.remoteHub) → SshFileSystem (ctx.fs provider).
 *
 * Gated on DSH_TEST_SSH_HOST: without the env vars (CI / bare `pnpm test`)
 * the whole suite is skipped. Bring up the container with:
 *
 *   eval "$(integration/run-sshd.sh start)"
 *   pnpm vitest run tests/integration
 *
 * Container fixtures (created by integration/sshd/entrypoint.sh, owner dsh):
 *   /home/dsh/work/hello.txt   "hello remote\nsecond line\n"
 *   /home/dsh/work/crlf.txt    "line1\r\nline2\r\n"
 *   /home/dsh/work/bin.dat     "a\0b"
 *   /home/dsh/work/large.bin   256 KiB random bytes
 *   /home/dsh/work/link.txt -> hello.txt
 *   /home/dsh/work/sub/        empty dir
 *
 * All writes go to /home/dsh/tmp-it/ (created in beforeAll, removed in
 * afterAll) so the fixtures stay pristine.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import RemoteHubPlugin from '@dsh-remote/remote-ssh';
import type { RemoteHub, RemoteTransport } from '@dsh-remote/remote';
import { FsError, FsVersion } from '@dsh-remote/seams';
import type { FsTarget } from '@dsh-remote/seams';
import { SshFileSystem } from '../../src/fs-ssh.js';

const HOST = process.env.DSH_TEST_SSH_HOST;
const PORT = Number(process.env.DSH_TEST_SSH_PORT ?? '22');
const USER = process.env.DSH_TEST_SSH_USER ?? 'dsh';
const KEY = process.env.DSH_TEST_SSH_KEY ?? '';

const WORK = '/home/dsh/work';
const TMP = '/home/dsh/tmp-it';
const LARGE_SIZE = 262_144;

async function collect(iter: AsyncIterable<string>): Promise<string> {
  let out = '';
  for await (const chunk of iter) out += chunk;
  return out;
}

async function expectFsError(p: Promise<unknown>, code: string): Promise<void> {
  await expect(p).rejects.toBeInstanceOf(FsError);
  await expect(p).rejects.toMatchObject({ code });
}

describe.skipIf(!HOST)('live sshd integration (remote + fs-ssh)', () => {
  let ctx: Context;
  let fiber: { dispose(): Promise<void> };
  let hub: RemoteHub;
  let fs: SshFileSystem;
  let transport: RemoteTransport;
  let targetId: string;

  /** Run a command on the remote host to completion, capturing output. */
  async function execSh(command: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const proc = await transport.exec(command);
    const drain = async (iter: AsyncIterable<Uint8Array>): Promise<Buffer[]> => {
      const chunks: Buffer[] = [];
      for await (const chunk of iter) chunks.push(Buffer.from(chunk));
      return chunks;
    };
    const [done, out, err] = await Promise.all([proc.done, drain(proc.stdout), drain(proc.stderr)]);
    return {
      code: done.code,
      stdout: Buffer.concat(out).toString('utf8'),
      stderr: Buffer.concat(err).toString('utf8'),
    };
  }

  const resolve = (path: string): Promise<FsTarget> => fs.resolve(path);

  beforeAll(async () => {
    ctx = new Context();
    fiber = await ctx.plugin(RemoteHubPlugin, {
      // TEST-ONLY: the target is a throwaway localhost container whose host
      // key changes on every rebuild, so pinning it is meaningless here.
      // Production callers must verify the fingerprint against a known_hosts
      // store instead of returning true unconditionally.
      hostVerifier: () => true,
    });
    hub = ctx.remoteHub;
    targetId = hub.addTarget({
      title: 'integration sshd container',
      ssh: {
        host: HOST!,
        port: PORT,
        username: USER,
        auth: { type: 'key', privateKeyPath: KEY },
        readyTimeoutMs: 15_000,
      },
    });
    transport = await hub.connect(targetId);
    fs = new SshFileSystem(ctx, {
      getTransport: () => hub.get(targetId),
      defaultCwd: WORK,
    });
    const { code, stderr } = await execSh(`mkdir -p ${TMP}`);
    if (code !== 0) throw new Error(`failed to create ${TMP}: ${stderr}`);
  }, 60_000);

  afterAll(async () => {
    try {
      if (transport) await execSh(`rm -rf ${TMP}`);
    } finally {
      await hub?.disconnect(targetId);
      await fiber?.dispose();
    }
  }, 30_000);

  it('connects with key auth and lands the runtime root on the remote host', async () => {
    expect(hub.status(targetId)).toBe('connected');
    expect(hub.get(targetId)).toBe(transport);
    const root = hub.runtimeRoot(targetId);
    expect(root).toMatch(/^\/home\/dsh\/\.cache\/dsh-remote\/[0-9a-f]{16}$/);
    const { code } = await execSh(`test -d ${root!}`);
    expect(code).toBe(0);
  });

  it('resolve canonicalizes symlinks: targetKey is the final realpath', async () => {
    const t = await resolve(`${WORK}/link.txt`);
    expect(t.targetKey).toBe(`${WORK}/hello.txt`);
    expect(t.displayPath).toBe(`${WORK}/link.txt`);
  });

  it('stat reports type/size/version; undefined when absent', async () => {
    const info = await fs.stat(await resolve(`${WORK}/hello.txt`));
    expect(info).toMatchObject({ type: 'file', size: 25 });
    expect(typeof info?.version).toBe('string');
    expect((await fs.stat(await resolve(WORK)))?.type).toBe('directory');
    expect(await fs.stat(await resolve(`${WORK}/missing.txt`))).toBeUndefined();
  });

  it('lstat reports the symlink itself without following it', async () => {
    expect((await fs.lstat(`${WORK}/link.txt`))?.type).toBe('symlink');
    expect((await fs.lstat(`${WORK}/hello.txt`))?.type).toBe('file');
    expect(await fs.lstat(`${WORK}/missing`)).toBeUndefined();
  });

  it('listDir returns children in stable name order', async () => {
    const target = await resolve(WORK);
    const first = await fs.listDir(target);
    const second = await fs.listDir(target);
    expect(first.map((e) => e.name)).toEqual([
      'bin.dat',
      'crlf.txt',
      'hello.txt',
      'large.bin',
      'link.txt',
      'sub',
    ]);
    expect(first.map((e) => e.name)).toEqual(second.map((e) => e.name));
    expect(first.map((e) => e.type)).toEqual([
      'file',
      'file',
      'file',
      'file',
      'other', // symlink: readdir attrs follow neither file nor directory
      'directory',
    ]);
    expect(first.find((e) => e.name === 'large.bin')?.size).toBe(LARGE_SIZE);
  });

  it('readText returns the exact remote content', async () => {
    expect(await fs.readText(await resolve(`${WORK}/hello.txt`))).toBe('hello remote\nsecond line\n');
  });

  it('streamText concatenated equals readText', async () => {
    const target = await resolve(`${WORK}/hello.txt`);
    const [streamed, whole] = await Promise.all([
      fs.streamText(target).then(collect),
      fs.readText(target),
    ]);
    expect(streamed).toBe(whole);
  });

  it('readBytes honors maxBytes exactly at the boundary', async () => {
    const target = await resolve(`${WORK}/large.bin`);
    const bytes = await fs.readBytes(target, undefined, LARGE_SIZE);
    expect(bytes.length).toBe(LARGE_SIZE);
    // Cross-check the payload against the remote checksum.
    const { stdout } = await execSh(`sha256sum ${WORK}/large.bin`);
    const remoteDigest = stdout.trim().split(/\s+/)[0];
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(remoteDigest);
    await expectFsError(fs.readBytes(target, undefined, LARGE_SIZE - 1), 'FS_TOO_LARGE');
  });

  it('readText rejects binary content with FS_NOT_TEXT', async () => {
    await expectFsError(fs.readText(await resolve(`${WORK}/bin.dat`)), 'FS_NOT_TEXT');
  });

  it('writeText unconditional creates and overwrites', async () => {
    const target = await resolve(`${TMP}/plain.txt`);
    const created = await fs.writeText(target, 'first\n');
    expect(created).toMatchObject({ operation: 'create', before: null, after: 'first\n' });

    const updated = await fs.writeText(target, 'second\n');
    expect(updated).toMatchObject({ operation: 'update', before: 'first\n', after: 'second\n' });
    expect(await fs.readText(target)).toBe('second\n');
  });

  it('writeText createIfAbsent conflicts with FS_NOT_OBSERVED on existing files', async () => {
    const existing = await resolve(`${WORK}/hello.txt`);
    await expectFsError(
      fs.writeText(existing, 'clobber', { kind: 'createIfAbsent' }),
      'FS_NOT_OBSERVED',
    );
    // The fixture must be untouched.
    expect(await fs.readText(existing)).toBe('hello remote\nsecond line\n');

    const created = await fs.writeText(await resolve(`${TMP}/guarded.txt`), 'made\n', {
      kind: 'createIfAbsent',
    });
    expect(created.operation).toBe('create');
  });

  it('writeText replaceIfVersion rejects stale tokens and accepts the fresh one', async () => {
    const target = await resolve(`${TMP}/versioned.txt`);
    await fs.writeText(target, 'v1\n');
    const v1 = (await fs.stat(target))!.version;

    await expectFsError(
      fs.writeText(target, 'v2\n', { kind: 'replaceIfVersion', version: FsVersion('bogus-token') }),
      'FS_STALE_VERSION',
    );
    expect(await fs.readText(target)).toBe('v1\n');

    // Replacing an absent target is stale too, never a silent create.
    await expectFsError(
      fs.writeText(await resolve(`${TMP}/absent.txt`), 'x\n', {
        kind: 'replaceIfVersion',
        version: v1,
      }),
      'FS_STALE_VERSION',
    );

    // Different length so the version cannot collapse onto v1's token even
    // within the same mtime second (v1 granularity is stat -c '%s %Y %a').
    const outcome = await fs.writeText(target, 'v2 has more bytes\n', {
      kind: 'replaceIfVersion',
      version: v1,
    });
    expect(outcome).toMatchObject({ operation: 'update', before: 'v1\n', after: 'v2 has more bytes\n' });
    expect(outcome.version).not.toBe(v1);
    expect((await fs.stat(target))!.version).toBe(outcome.version);
  });

  it('editText preserves CRLF line endings on the remote side', async () => {
    const { code } = await execSh(`cp ${WORK}/crlf.txt ${TMP}/crlf.txt`);
    expect(code).toBe(0);
    const target = await resolve(`${TMP}/crlf.txt`);
    // Raw storage is CRLF; the edit basis is LF-normalized.
    const outcome = await fs.editText(target, {
      oldString: 'line2',
      newString: 'LINE2',
      replaceAll: false,
    });
    expect(outcome.before).toBe('line1\nline2\n');
    expect(outcome.after).toBe('line1\nLINE2\n');

    const bytes = await fs.readBytes(target, undefined, 1024);
    expect(Buffer.from(bytes).toString('utf8')).toBe('line1\r\nLINE2\r\n');
  });

  it('contains uses boundary-safe prefix semantics (/a/b vs /a/bc)', async () => {
    const parent = await resolve('/a/b');
    expect(fs.contains(parent, await resolve('/a/b'))).toBe(true);
    expect(fs.contains(parent, await resolve('/a/b/c'))).toBe(true);
    expect(fs.contains(parent, await resolve('/a/bc'))).toBe(false);
    expect(fs.contains(await resolve('/'), await resolve('/anything'))).toBe(true);
  });

  it('stat version changes after a write', async () => {
    const target = await resolve(`${TMP}/freshness.txt`);
    await fs.writeText(target, 'short\n');
    const before = (await fs.stat(target))!.version;
    // Different size guarantees a different freshness tuple regardless of
    // whole-second mtime granularity.
    await fs.writeText(target, 'considerably longer content\n');
    const after = (await fs.stat(target))!.version;
    expect(after).not.toBe(before);
  });
});
