/**
 * Backend pairing-token storage. v1 stores the PLAINTEXT 256-bit token in
 * `backend.json` — the daemon host is trusted, and the file is protected by
 * permissions (directory 0700, file 0600) rather than at-rest hashing. The
 * hash-only alternative (auth.ts `hashTokenForStorage`) is a later revision.
 *
 * All writes are atomic: the JSON goes to a same-directory temporary file
 * (mode 0600), is fsynced, then renamed over the target.
 */
import { constants } from 'node:fs';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { generateToken } from '@dsh-remote/core';

/** On-disk shape of the backend config file. */
export interface BackendConfig {
  version: 1;
  /** v1: plaintext pairing token (base64url, 32 bytes of entropy). */
  token: string;
  /** ISO-8601 creation/rotation time. */
  createdAt: string;
  /** Human note, because JSON has no comments. */
  note: string;
}

const CONFIG_FILE = 'backend.json';

/** Config directory: $DSH_REMOTE_CONFIG_DIR or ~/.config/dsh-remote. */
export function configDir(explicit?: string): string {
  return explicit ?? process.env['DSH_REMOTE_CONFIG_DIR'] ?? join(homedir(), '.config', 'dsh-remote');
}

/** Full path of the backend config file inside `dir`. */
export function configPath(dir?: string): string {
  return join(configDir(dir), CONFIG_FILE);
}

/** Load the pairing token, or undefined when the backend was never initialized. */
export async function loadToken(dir?: string): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await readFile(configPath(dir), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  const parsed = JSON.parse(raw) as Partial<BackendConfig>;
  if (parsed.version !== 1 || typeof parsed.token !== 'string' || parsed.token === '') {
    throw new Error(`invalid backend config at ${configPath(dir)}`);
  }
  return parsed.token;
}

export interface WriteConfigOptions {
  /** Refuse when a config already exists (default true; false = rotate). */
  overwrite?: boolean;
  /** Token to store; a fresh one is generated when omitted. */
  token?: string;
}

/**
 * Write a fresh backend config atomically. Returns the token (so the caller
 * can show it exactly once) and the file path.
 */
export async function writeConfig(
  dir: string | undefined,
  options: WriteConfigOptions = {},
): Promise<{ token: string; path: string }> {
  const targetDir = configDir(dir);
  const target = join(targetDir, CONFIG_FILE);
  await mkdir(targetDir, { recursive: true, mode: 0o700 });
  await chmod(targetDir, 0o700).catch(() => {});
  if (options.overwrite !== true) {
    try {
      await readFile(target);
      throw new Error(
        `backend config already exists at ${target}; pass --rotate-token to replace it`,
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  const token = options.token ?? generateToken();
  const config: BackendConfig = {
    version: 1,
    token,
    createdAt: new Date().toISOString(),
    note: 'v1 stores the plaintext pairing token; keep this file mode 0600 and never commit it.',
  };
  const tmp = join(targetDir, `.${CONFIG_FILE}.${process.pid}.${Date.now()}.tmp`);
  const handle = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await handle.writeFile(JSON.stringify(config, null, 2) + '\n', 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tmp, target);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  await chmod(target, 0o600).catch(() => {});
  return { token, path: target };
}
