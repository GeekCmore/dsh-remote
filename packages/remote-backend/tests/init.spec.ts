import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadToken } from '../src/config.js';
import { runInit } from '../src/init.js';

async function makeDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-backend-init-'));
}

describe('dsh-remote-backend init', () => {
  it('writes backend.json atomically with 0600 in a 0700 dir and prints the token once', async () => {
    const dir = await makeDir();
    const printed: string[] = [];
    const result = await runInit({ configDir: dir, out: (line) => printed.push(line) });

    expect(result.rotated).toBe(false);
    const info = await stat(result.path);
    expect(info.mode & 0o777).toBe(0o600);
    const dirInfo = await stat(dir);
    expect(dirInfo.mode & 0o777).toBe(0o700);

    // Round-trip: the stored token loads back and matches the printed one.
    expect(await loadToken(dir)).toBe(result.token);
    expect(printed.some((line) => line === result.token)).toBe(true);
    const stored = JSON.parse(await readFile(result.path, 'utf8')) as { token: string; version: number };
    expect(stored.version).toBe(1);
    expect(stored.token).toBe(result.token);
  });

  it('refuses to clobber an existing config without --rotate-token', async () => {
    const dir = await makeDir();
    const first = await runInit({ configDir: dir, out: () => {} });
    await expect(runInit({ configDir: dir, out: () => {} })).rejects.toThrow(/already exists/);
    expect(await loadToken(dir)).toBe(first.token);
  });

  it('rotates the token with --rotate-token, invalidating the old one', async () => {
    const dir = await makeDir();
    const first = await runInit({ configDir: dir, out: () => {} });
    const second = await runInit({ configDir: dir, rotateToken: true, out: () => {} });
    expect(second.rotated).toBe(true);
    expect(second.token).not.toBe(first.token);
    expect(await loadToken(dir)).toBe(second.token);
    expect((await stat(second.path)).mode & 0o777).toBe(0o600);
  });

  it('tightens a loose existing config directory to 0700', async () => {
    const dir = await makeDir();
    await chmod(dir, 0o755);
    await runInit({ configDir: dir, out: () => {} });
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it('loadToken returns undefined when the backend was never initialized', async () => {
    const dir = await makeDir();
    expect(await loadToken(dir)).toBeUndefined();
  });

  it('loadToken rejects a corrupt config', async () => {
    const dir = await makeDir();
    await writeFile(join(dir, 'backend.json'), '{"version":1}', 'utf8');
    await expect(loadToken(dir)).rejects.toThrow(/invalid backend config/);
  });
});
