import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseServeArgs,
  redirectConsoleToStderr,
  serveProfile,
  type AppBootModule,
} from '../src/profile-boot.js';

// serveProfile redirects console.log/info/debug to stderr (stdout hygiene);
// restore the originals after every test so vitest's own output is unaffected.
const originalConsole = { log: console.log, info: console.info, debug: console.debug };
afterEach(() => {
  console.log = originalConsole.log;
  console.info = originalConsole.info;
  console.debug = originalConsole.debug;
});

async function makeDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-backend-profile-'));
}

interface BootCall {
  binName: string;
  rootConfig: string;
  patches: unknown[];
}

/** Fake dsh-app-boot module: records boot(), returns a fabricated context. */
function fakeAppBoot(options: {
  profileDir: string;
  patches?: { layers?: unknown[]; own?: unknown[] };
  entries?: { name: string; disabled?: boolean }[];
  bootError?: Error;
}): { appBoot: AppBootModule; calls: BootCall[]; disposed: () => boolean } {
  const calls: BootCall[] = [];
  let disposed = false;
  const appBoot = {
    resolveProfileDir: () => options.profileDir,
    loadProfile: () => ({
      name: 'fake',
      dir: options.profileDir,
      layers: (options.patches?.layers ?? []).map((patches) => ({
        packageName: 'fake-bundle',
        packageDir: options.profileDir,
        patchPath: join(options.profileDir, 'bundle.patch.yml'),
        patches,
      })),
      patchPath: join(options.profileDir, 'cordis.patch.yml'),
      patches: options.patches?.own ?? [],
    }),
    installFailLoud: () => () => {},
    boot: async (binName: string, rootConfig: string, patches?: unknown[]) => {
      calls.push({ binName, rootConfig, patches: patches ?? [] });
      if (options.bootError) throw options.bootError;
      return {
        loader: {
          *entries() {
            for (const entry of options.entries ?? []) {
              yield { options: { name: entry.name }, disabled: entry.disabled ?? false };
            }
          },
        },
        fiber: {
          dispose: async () => {
            disposed = true;
          },
        },
      };
    },
  } as unknown as AppBootModule;
  return { appBoot, calls, disposed: () => disposed };
}

describe('parseServeArgs', () => {
  it('parses no --profile as the standalone empty host (profile undefined)', () => {
    expect(parseServeArgs([])).toEqual({});
  });

  it('parses --profile <name> and --profile=<name>', () => {
    expect(parseServeArgs(['--profile', 'daemon'])).toEqual({ profile: 'daemon' });
    expect(parseServeArgs(['--profile=daemon'])).toEqual({ profile: 'daemon' });
  });

  it('rejects --profile without a value', () => {
    expect(() => parseServeArgs(['--profile'])).toThrow(/requires a profile name/);
    expect(() => parseServeArgs(['--profile='])).toThrow(/requires a profile name/);
    expect(() => parseServeArgs(['--profile', '--rotate-token'])).toThrow(/requires a profile name/);
  });

  it('rejects unknown serve arguments', () => {
    expect(() => parseServeArgs(['--bogus'])).toThrow(/unknown serve argument/);
  });
});

describe('serveProfile', () => {
  it('fails loud when the profile directory does not exist', async () => {
    const missing = join(await makeDir(), 'no-such-profile');
    const { appBoot, calls } = fakeAppBoot({ profileDir: missing });
    await expect(serveProfile('ghost', { appBoot, diag: () => {} })).rejects.toThrow(
      /profile "ghost" not found/,
    );
    expect(calls).toHaveLength(0);
  });

  it('composes bundle + profile patch layers over a rewritten empty root config', async () => {
    const dir = await makeDir();
    const bundlePatches = [{ insert: [{ id: 'base', name: '@deepseek-ai/dsh-base' }] }];
    const ownPatches = [{ id: 'base', config: { x: 1 } }];
    const { appBoot, calls } = fakeAppBoot({
      profileDir: dir,
      patches: { layers: [bundlePatches], own: ownPatches },
      entries: [{ name: '@dsh-remote/backend' }],
    });

    await serveProfile('daemon', { appBoot, diag: () => {} });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.binName).toBe('dsh-remote-backend');
    expect(calls[0]!.rootConfig).toBe(join(dir, 'cordis.yml'));
    expect(calls[0]!.patches).toEqual([...bundlePatches, ...ownPatches]);
    // Root config rewritten to the empty entry list (composition is patches).
    expect(await readFile(join(dir, 'cordis.yml'), 'utf8')).toMatch(/\[\]\s*$/);
  });

  it('fails loud and disposes the tree when the profile does not mount the backend plugin', async () => {
    const dir = await makeDir();
    const { appBoot, disposed } = fakeAppBoot({
      profileDir: dir,
      entries: [{ name: '@deepseek-ai/dsh-base' }],
    });
    await expect(serveProfile('daemon', { appBoot, diag: () => {} })).rejects.toThrow(
      /does not mount @dsh-remote\/backend/,
    );
    expect(disposed()).toBe(true);
  });

  it('treats a disabled backend row as not mounted', async () => {
    const dir = await makeDir();
    const { appBoot } = fakeAppBoot({
      profileDir: dir,
      entries: [{ name: '@dsh-remote/backend', disabled: true }],
    });
    await expect(serveProfile('daemon', { appBoot, diag: () => {} })).rejects.toThrow(
      /does not mount @dsh-remote\/backend/,
    );
  });

  it('propagates boot failures (fail loud, non-zero exit is the caller)', async () => {
    const dir = await makeDir();
    const { appBoot } = fakeAppBoot({
      profileDir: dir,
      bootError: new Error('plugin tree failed to load: boom'),
    });
    await expect(serveProfile('daemon', { appBoot, diag: () => {} })).rejects.toThrow(
      /plugin tree failed to load/,
    );
  });
});

describe('redirectConsoleToStderr (stdout hygiene)', () => {
  it('routes console.log/info/debug to stderr and leaves console.error alone', async () => {
    const original = { log: console.log, info: console.info, debug: console.debug };
    const written: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      redirectConsoleToStderr();
      expect(console.log).not.toBe(original.log);
      console.log('hello %s', 'world');
      expect(written).toEqual(['hello world\n']);
    } finally {
      console.log = original.log;
      console.info = original.info;
      console.debug = original.debug;
      process.stderr.write = originalWrite;
    }
  });
});
