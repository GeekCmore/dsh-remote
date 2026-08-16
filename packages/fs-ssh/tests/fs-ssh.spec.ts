import { describe, expect, it } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { FsError, FsVersion } from '@dsh-remote/seams';
import type { FsObservation, FsTarget, FsWriteIntent } from '@dsh-remote/seams';
import { SshFileSystem } from '../src/fs-ssh.js';
import { FakeTransport } from './fake-transport.js';
import type { FakeTransportOptions } from './fake-transport.js';

function setup(fakeOptions: FakeTransportOptions = {}) {
  const ctx = new Context();
  const fake = new FakeTransport(fakeOptions);
  const transportHolder: { current: FakeTransport | undefined } = { current: fake };
  const fs = new SshFileSystem(ctx, {
    getTransport: () => transportHolder.current,
    defaultCwd: '/work',
  });
  fake.mkdir('/work');
  return { ctx, fake, fs, transportHolder };
}

async function expectFsError(p: Promise<unknown>, code: string): Promise<void> {
  await expect(p).rejects.toBeInstanceOf(FsError);
  await expect(p).rejects.toMatchObject({ code });
}

async function collect(iter: AsyncIterable<string>): Promise<string> {
  let out = '';
  for await (const chunk of iter) out += chunk;
  return out;
}

describe('resolve / identity', () => {
  it('resolves relative paths against defaultCwd and opts.cwd', async () => {
    const { fs } = setup();
    const a = await fs.resolve('a.txt');
    expect(a.targetKey).toBe('/work/a.txt');
    expect(a.displayPath).toBe('/work/a.txt');
    const b = await fs.resolve('b.txt', { cwd: '/etc' });
    expect(b.targetKey).toBe('/etc/b.txt');
    const c = await fs.resolve('./sub/../c.txt');
    expect(c.targetKey).toBe('/work/c.txt');
  });

  it('canonicalizes through symlinks for targetKey but keeps the caller form as displayPath', async () => {
    const { fs, fake } = setup();
    fake.writeFile('/work/real.txt', 'x');
    fake.symlink('real.txt', '/work/link.txt');
    const t = await fs.resolve('/work/link.txt');
    expect(t.targetKey).toBe('/work/real.txt');
    expect(t.displayPath).toBe('/work/link.txt');
  });

  it('resolves paths that do not exist yet (realpath -m semantics)', async () => {
    const { fs } = setup();
    const t = await fs.resolve('/work/future/new.txt');
    expect(t.targetKey).toBe('/work/future/new.txt');
  });

  it('caches resolutions and invalidates on mutation', async () => {
    const { fs, fake } = setup();
    const first = await fs.resolve('/work/cached.txt');
    const second = await fs.resolve('/work/cached.txt');
    expect(second.targetKey).toBe(first.targetKey);
    expect(fake.execCount).toBe(1);
    // resolve (1) + unguarded writeText's force-publish exec (1) + resolve again (1)
    await fs.writeText(first, 'x');
    await fs.resolve('/work/cached.txt');
    expect(fake.execCount).toBe(3);
  });
});

describe('processPath / fileUrl / contains', () => {
  it('processPath is the remote absolute path', async () => {
    const { fs } = setup();
    const t = await fs.resolve('/work/a.txt');
    expect(fs.processPath(t)).toBe('/work/a.txt');
  });

  it('fileUrl percent-encodes per RFC 8089', async () => {
    const { fs } = setup();
    const t = await fs.resolve('/work/a b/中.txt');
    expect(fs.fileUrl(t)).toBe('file:///work/a%20b/%E4%B8%AD.txt');
  });

  it('contains uses boundary-safe prefix semantics', async () => {
    const { fs } = setup();
    const parent = await fs.resolve('/a/b');
    expect(fs.contains(parent, await fs.resolve('/a/b'))).toBe(true);
    expect(fs.contains(parent, await fs.resolve('/a/b/c'))).toBe(true);
    expect(fs.contains(parent, await fs.resolve('/a/bc'))).toBe(false);
    expect(fs.contains(await fs.resolve('/'), await fs.resolve('/anything'))).toBe(true);
  });
});

describe('stat / lstat', () => {
  it('stats files and directories, undefined when absent', async () => {
    const { fs, fake } = setup();
    fake.writeFile('/work/f.txt', 'hello');
    const fileTarget = await fs.resolve('/work/f.txt');
    const info = await fs.stat(fileTarget);
    expect(info).toMatchObject({ type: 'file', size: 5 });
    expect(typeof info?.version).toBe('string');
    const dirInfo = await fs.stat(await fs.resolve('/work'));
    expect(dirInfo?.type).toBe('directory');
    expect(await fs.stat(await fs.resolve('/work/missing.txt'))).toBeUndefined();
  });

  it('version changes when the file changes', async () => {
    const { fs, fake } = setup();
    fake.writeFile('/work/v.txt', 'one');
    const t = await fs.resolve('/work/v.txt');
    const v1 = (await fs.stat(t))!.version;
    fake.writeFile('/work/v.txt', 'two!');
    const v2 = (await fs.stat(t))!.version;
    expect(v1).not.toBe(v2);
  });

  it('lstat reports symlinks without following them', async () => {
    const { fs, fake } = setup();
    fake.writeFile('/work/real.txt', 'x');
    fake.symlink('real.txt', '/work/link.txt');
    const info = await fs.lstat('/work/link.txt');
    expect(info?.type).toBe('symlink');
    expect(await fs.lstat('link.txt')).toMatchObject({ type: 'symlink' });
    expect(await fs.lstat('/work/missing')).toBeUndefined();
  });
});

describe('listDir', () => {
  it('lists children in stable name order with resolved child targets', async () => {
    const { fs, fake } = setup();
    fake.mkdir('/work/dir');
    fake.writeFile('/work/dir/b.txt', 'b');
    fake.writeFile('/work/dir/a.txt', 'aa');
    fake.mkdir('/work/dir/sub');
    fake.symlink('a.txt', '/work/dir/ln');
    const entries = await fs.listDir(await fs.resolve('/work/dir'));
    expect(entries.map((e) => e.name)).toEqual(['a.txt', 'b.txt', 'ln', 'sub']);
    expect(entries.map((e) => e.type)).toEqual(['file', 'file', 'other', 'directory']);
    expect(entries[0]!.target.targetKey).toBe('/work/dir/a.txt');
    expect(entries[0]!.size).toBe(2);
  });

  it('fails for missing dirs and non-directories', async () => {
    const { fs, fake } = setup();
    fake.writeFile('/work/f.txt', 'x');
    await expectFsError(fs.listDir(await fs.resolve('/work/nope')), 'FS_NOT_FOUND');
    await expectFsError(fs.listDir(await fs.resolve('/work/f.txt')), 'FS_NOT_DIRECTORY');
  });
});

describe('readText / streamText', () => {
  it('reads UTF-8 text', async () => {
    const { fs, fake } = setup();
    fake.writeFile('/work/t.txt', 'héllo 中文\n');
    expect(await fs.readText(await fs.resolve('/work/t.txt'))).toBe('héllo 中文\n');
  });

  it('rejects absent files, directories and binary content', async () => {
    const { fs, fake } = setup();
    fake.writeFile('/work/bin', new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]));
    await expectFsError(fs.readText(await fs.resolve('/work/missing')), 'FS_NOT_FOUND');
    await expectFsError(fs.readText(await fs.resolve('/work')), 'FS_NOT_REGULAR_FILE');
    await expectFsError(fs.readText(await fs.resolve('/work/bin')), 'FS_NOT_TEXT');
  });

  it('streamText decodes multibyte characters split across chunks', async () => {
    const { fs, fake } = setup({ readChunkSize: 3 });
    fake.writeFile('/work/u.txt', 'a中文b𐍈c');
    const t = await fs.resolve('/work/u.txt');
    expect(await collect(await fs.streamText(t))).toBe('a中文b𐍈c');
  });

  it('streamText rejects binary content mid-stream', async () => {
    const { fs, fake } = setup({ readChunkSize: 4 });
    fake.writeFile('/work/bin2', new Uint8Array([97, 98, 99, 100, 0, 101]));
    const iter = await fs.streamText(await fs.resolve('/work/bin2'));
    await expect(collect(iter)).rejects.toMatchObject({ code: 'FS_NOT_TEXT' });
  });
});

describe('readBytes', () => {
  it('returns raw bytes within the cap', async () => {
    const { fs, fake } = setup();
    fake.writeFile('/work/b.bin', new Uint8Array([1, 2, 0, 3]));
    const bytes = await fs.readBytes(await fs.resolve('/work/b.bin'), undefined, 10);
    expect([...bytes]).toEqual([1, 2, 0, 3]);
  });

  it('short-circuits via stat when size exceeds the cap', async () => {
    const { fs, fake } = setup();
    fake.writeFile('/work/big.bin', 'x'.repeat(100));
    await expectFsError(fs.readBytes(await fs.resolve('/work/big.bin'), undefined, 50), 'FS_TOO_LARGE');
  });

  it('cancels mid-stream when content grows past the cap despite stat', async () => {
    const { fs, fake } = setup({ readChunkSize: 30 });
    fake.writeFile('/work/lie.bin', 'x'.repeat(100));
    fake.sizeOverrides.set('/work/lie.bin', 10);
    await expectFsError(fs.readBytes(await fs.resolve('/work/lie.bin'), undefined, 50), 'FS_TOO_LARGE');
  });
});

describe('writeText', () => {
  it('creates unconditionally and reports a null before', async () => {
    const { fs, fake } = setup();
    const t = await fs.resolve('/work/new.txt');
    const outcome = await fs.writeText(t, 'fresh content');
    expect(outcome.operation).toBe('create');
    expect(outcome.before).toBeNull();
    expect(outcome.after).toBe('fresh content');
    expect(new TextDecoder().decode(fake.readFile('/work/new.txt'))).toBe('fresh content');
    expect((await fs.stat(t))!.version).toBe(outcome.version);
  });

  it('overwrites unconditionally and reports the LF-normalized before', async () => {
    const { fs, fake } = setup();
    fake.writeFile('/work/existing.txt', 'old\r\ntext\r\n');
    const t = await fs.resolve('/work/existing.txt');
    const outcome = await fs.writeText(t, 'new');
    expect(outcome.operation).toBe('update');
    expect(outcome.before).toBe('old\ntext\n');
  });

  it('before is null when the prior file is binary', async () => {
    const { fs, fake } = setup();
    fake.writeFile('/work/prior.bin', new Uint8Array([1, 0, 2]));
    const outcome = await fs.writeText(await fs.resolve('/work/prior.bin'), 'text now');
    expect(outcome.operation).toBe('update');
    expect(outcome.before).toBeNull();
  });

  it('createIfAbsent rejects existing targets with FS_NOT_OBSERVED', async () => {
    const { fs, fake } = setup();
    fake.writeFile('/work/guard.txt', 'keep me');
    await expectFsError(
      fs.writeText(await fs.resolve('/work/guard.txt'), 'clobber', { kind: 'createIfAbsent' }),
      'FS_NOT_OBSERVED',
    );
    expect(new TextDecoder().decode(fake.readFile('/work/guard.txt'))).toBe('keep me');
  });

  it('createIfAbsent creates absent targets', async () => {
    const { fs, fake } = setup();
    const outcome = await fs.writeText(await fs.resolve('/work/ca.txt'), 'made', {
      kind: 'createIfAbsent',
    });
    expect(outcome.operation).toBe('create');
    expect(new TextDecoder().decode(fake.readFile('/work/ca.txt'))).toBe('made');
  });

  it('replaceIfVersion rejects a mismatched token with FS_STALE_VERSION', async () => {
    const { fs, fake } = setup();
    fake.writeFile('/work/rv.txt', 'v1');
    await expectFsError(
      fs.writeText(await fs.resolve('/work/rv.txt'), 'v2', {
        kind: 'replaceIfVersion',
        version: FsVersion('bogus-token'),
      }),
      'FS_STALE_VERSION',
    );
  });

  it('replaceIfVersion rejects an absent target with FS_STALE_VERSION', async () => {
    const { fs } = setup();
    await expectFsError(
      fs.writeText(await fs.resolve('/work/absent.txt'), 'v2', {
        kind: 'replaceIfVersion',
        version: FsVersion('bogus'),
      }),
      'FS_STALE_VERSION',
    );
  });

  it('replaceIfVersion publishes with the matching token', async () => {
    const { fs, fake } = setup();
    fake.writeFile('/work/ok.txt', 'v1');
    const t = await fs.resolve('/work/ok.txt');
    const version = (await fs.stat(t))!.version;
    const outcome = await fs.writeText(t, 'v2', { kind: 'replaceIfVersion', version });
    expect(outcome.after).toBe('v2');
    expect(new TextDecoder().decode(fake.readFile('/work/ok.txt'))).toBe('v2');
  });

  it('detects a remote-side change between observation and publish (remote critical section)', async () => {
    const interfering = new FakeTransport({
      onExec(command) {
        if (command.startsWith('dsh_remote_publish() {')) {
          // Another writer lands between our stat and our publish script.
          interfering.writeFile('/work/race.txt', 'other writer');
        }
      },
    });
    interfering.mkdir('/work');
    interfering.writeFile('/work/race.txt', 'original');
    const fs = new SshFileSystem(new Context(), {
      getTransport: () => interfering,
      defaultCwd: '/work',
    });
    const t = await fs.resolve('/work/race.txt');
    const version = (await fs.stat(t))!.version;
    await expectFsError(
      fs.writeText(t, 'mine', { kind: 'replaceIfVersion', version }),
      'FS_STALE_VERSION',
    );
    expect(new TextDecoder().decode(interfering.readFile('/work/race.txt'))).toBe('other writer');
    // The staged temp file is cleaned up on guard failure.
    expect(interfering.exists('/work/race.txt.dsh-remote-tmp-' + 'x'.repeat(12))).toBe(false);
  });
});

describe('editText', () => {
  it('replaces a literal match and reports before/after', async () => {
    const { fs, fake } = setup();
    fake.writeFile('/work/e.txt', 'hello world\n');
    const t = await fs.resolve('/work/e.txt');
    const outcome = await fs.editText(t, {
      oldString: 'world',
      newString: 'there',
      replaceAll: false,
    });
    expect(outcome.before).toBe('hello world\n');
    expect(outcome.after).toBe('hello there\n');
    expect(new TextDecoder().decode(fake.readFile('/work/e.txt'))).toBe('hello there\n');
    expect((await fs.stat(t))!.version).toBe(outcome.version);
  });

  it('fails with FS_EDIT_NOT_FOUND when the text is absent', async () => {
    const { fs, fake } = setup();
    fake.writeFile('/work/e2.txt', 'abc');
    await expectFsError(
      fs.editText(await fs.resolve('/work/e2.txt'), {
        oldString: 'zzz',
        newString: 'q',
        replaceAll: false,
      }),
      'FS_EDIT_NOT_FOUND',
    );
  });

  it('fails with FS_AMBIGUOUS_EDIT on multiple matches unless replaceAll', async () => {
    const { fs, fake } = setup();
    fake.writeFile('/work/e3.txt', 'foo bar foo');
    const t = await fs.resolve('/work/e3.txt');
    await expectFsError(
      fs.editText(t, { oldString: 'foo', newString: 'x', replaceAll: false }),
      'FS_AMBIGUOUS_EDIT',
    );
    const outcome = await fs.editText(t, { oldString: 'foo', newString: 'x', replaceAll: true });
    expect(outcome.after).toBe('x bar x');
  });

  it('round-trips CRLF storage while reporting LF-normalized before/after', async () => {
    const { fs, fake } = setup();
    fake.writeFile('/work/crlf.txt', 'a\r\nb\r\nc\r\n');
    const outcome = await fs.editText(await fs.resolve('/work/crlf.txt'), {
      oldString: 'b',
      newString: 'B',
      replaceAll: false,
    });
    expect(outcome.before).toBe('a\nb\nc\n');
    expect(outcome.after).toBe('a\nB\nc\n');
    expect(new TextDecoder().decode(fake.readFile('/work/crlf.txt'))).toBe('a\r\nB\r\nc\r\n');
  });

  it('checks the version guard before matching (FS_STALE_VERSION wins over match errors)', async () => {
    const { fs, fake } = setup();
    fake.writeFile('/work/e4.txt', 'content');
    const t = await fs.resolve('/work/e4.txt');
    await expectFsError(
      fs.editText(
        t,
        { oldString: 'not even present', newString: 'x', replaceAll: false },
        { version: FsVersion('stale') },
      ),
      'FS_STALE_VERSION',
    );
    const version = (await fs.stat(t))!.version;
    const outcome = await fs.editText(
      t,
      { oldString: 'content', newString: 'next', replaceAll: false },
      { version },
    );
    expect(outcome.after).toBe('next');
  });

  it('rejects absent targets, directories and binary content', async () => {
    const { fs, fake } = setup();
    fake.writeFile('/work/e5.bin', new Uint8Array([0, 1, 2]));
    const edit = { oldString: 'a', newString: 'b', replaceAll: false };
    await expectFsError(fs.editText(await fs.resolve('/work/gone.txt'), edit), 'FS_NOT_FOUND');
    await expectFsError(fs.editText(await fs.resolve('/work'), edit), 'FS_NOT_REGULAR_FILE');
    await expectFsError(fs.editText(await fs.resolve('/work/e5.bin'), edit), 'FS_NOT_TEXT');
  });
});

describe('events', () => {
  it('emits fs/observed for present and absent observations', async () => {
    const { ctx, fs, fake } = setup();
    const seen: Array<{ target: FsTarget; observation: FsObservation }> = [];
    ctx.on('fs/observed', (target, observation) => {
      seen.push({ target, observation });
    });
    fake.writeFile('/work/obs.txt', 'x');
    await fs.stat(await fs.resolve('/work/obs.txt'));
    await fs.stat(await fs.resolve('/work/not-here.txt'));
    await fs.readText(await fs.resolve('/work/obs.txt'));
    await fs.listDir(await fs.resolve('/work'));
    const kinds = seen.map((s) => s.observation.kind);
    expect(kinds).toContain('present');
    expect(kinds).toContain('absent');
    const absent = seen.find((s) => s.observation.kind === 'absent')!;
    expect(absent.target.targetKey).toBe('/work/not-here.txt');
  });

  it('fs/write-intent injects a guard; an explicit expected wins', async () => {
    const { ctx, fs, fake } = setup();
    fake.writeFile('/work/wi.txt', 'existing');
    ctx.on('fs/write-intent', (_target, _actor, next) => {
      void next;
      return Promise.resolve({ kind: 'createIfAbsent' } satisfies FsWriteIntent);
    });
    const t = await fs.resolve('/work/wi.txt');
    // Injected guard applies when the caller passes nothing.
    await expectFsError(fs.writeText(t, 'x'), 'FS_NOT_OBSERVED');
    // Explicit expected overrides the injected intent.
    const version = (await fs.stat(t))!.version;
    const outcome = await fs.writeText(t, 'x', { kind: 'replaceIfVersion', version });
    expect(outcome.after).toBe('x');
  });

  it('fs/edit-intent injects a version guard', async () => {
    const { ctx, fs, fake } = setup();
    fake.writeFile('/work/ei.txt', 'content');
    ctx.on('fs/edit-intent', (_target, _actor, next) => {
      void next;
      return Promise.resolve({ version: FsVersion('policy-stale') });
    });
    await expectFsError(
      fs.editText(await fs.resolve('/work/ei.txt'), {
        oldString: 'content',
        newString: 'x',
        replaceAll: false,
      }),
      'FS_STALE_VERSION',
    );
  });
});

describe('abort and connection loss', () => {
  it('rejects with FS_ABORTED on a pre-aborted signal', async () => {
    const { fs, fake } = setup();
    fake.writeFile('/work/a.txt', 'x');
    const controller = new AbortController();
    controller.abort();
    const t = await fs.resolve('/work/a.txt');
    await expectFsError(fs.readText(t, controller.signal), 'FS_ABORTED');
    await expectFsError(fs.writeText(t, 'y', undefined, controller.signal), 'FS_ABORTED');
    await expectFsError(fs.resolve('/work/b.txt', { signal: controller.signal }), 'FS_ABORTED');
  });

  it('maps a missing transport to FS_IO_ERROR with connection semantics in cause', async () => {
    const { fs, transportHolder } = setup();
    transportHolder.current = undefined;
    try {
      await fs.resolve('/work/x.txt');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FsError);
      expect((e as FsError).code).toBe('FS_IO_ERROR');
      expect((e as FsError).cause).toBeInstanceOf(Error);
      expect(String((e as FsError).cause)).toMatch(/connection/i);
    }
    await expectFsError(fs.writeText({ targetKey: '/work/x' as FsTarget['targetKey'], displayPath: '/work/x' }, 'x'), 'FS_IO_ERROR');
  });

  it('maps a lost connection mid-flight to FS_IO_ERROR', async () => {
    const { fs, fake } = setup();
    fake.writeFile('/work/c.txt', 'x');
    const t = await fs.resolve('/work/c.txt');
    fake.closed = true;
    await expectFsError(fs.stat(t), 'FS_IO_ERROR');
  });
});
