/**
 * Shared helpers for the SSH subprocess provider: transport access, error
 * shaping, exec-to-completion, and poll ticks.
 */
import type { ExecProcess, RemoteTransport } from '@dsh-remote/remote';
import { sq } from './wrapper.js';

/** Normalize an unknown rejection into an Error. */
export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Abortion check as a function boundary, so TS narrowing never goes stale across awaits. */
export function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** Extract a `TransportError`-shaped code without an instanceof link to one class. */
export function transportCode(e: unknown): string | undefined {
  if (e instanceof Error && e.name === 'TransportError' && 'code' in e) {
    return (e as { code: string }).code;
  }
  return undefined;
}

/** True when the failure proves the remote execution world is gone. */
export function isConnLost(e: unknown): boolean {
  return transportCode(e) === 'CONN_LOST';
}

/**
 * Infrastructure-failure error for live handles. The subprocess seam defines
 * no dedicated error class (unlike the fs seam's FsError), so — matching the
 * upstream e2b adapter, which surfaces SDK errors as plain Errors — a lost
 * connection rejects `done` with an Error whose `cause` carries the
 * transport's CONN_LOST semantics.
 */
export function connLostError(what: string, cause?: unknown): Error {
  return new Error(`subprocess-ssh: ${what}: remote connection lost`, {
    cause: cause ?? new Error('remote transport unavailable: connection down or not yet established'),
  });
}

/** Resolve after one duration. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait one poll interval or until the signal aborts.
 * @returns `true` after a full tick, `false` when aborted first.
 */
export function waitTick(pollMs: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted === true) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, pollMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Run an exec command to completion, capturing stdout/stderr text. */
export async function execCapture(
  transport: RemoteTransport,
  command: string,
  signal?: AbortSignal,
  env?: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const proc = await transport.exec(command, {
    ...(signal === undefined ? {} : { signal }),
    ...(env === undefined ? {} : { env }),
  });
  const drain = async (iter: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of iter) chunks.push(chunk);
    return chunks;
  };
  const [done, outChunks, errChunks] = await Promise.all([
    proc.done,
    drain(proc.stdout),
    drain(proc.stderr),
  ]);
  const decoder = new TextDecoder('utf-8');
  return {
    code: done.code,
    stdout: decoder.decode(concatBytes(outChunks)),
    stderr: decoder.decode(concatBytes(errChunks)),
  };
}

export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Signal remote process groups, tolerating the shared teardown outcomes: a
 * nonzero `kill` (groups already gone) and a lost connection (nothing left to
 * signal). Both the process and terminal teardown ladders deliver through
 * this single tolerance so they cannot drift apart.
 */
export async function signalRemoteGroups(
  transport: RemoteTransport,
  groups: readonly number[],
  signal: 'TERM' | 'KILL',
): Promise<void> {
  // Numeric pgids have no identity fence against reuse; keeping the ladder's
  // host round-trips minimal is the mitigation (same posture as upstream).
  // No `--` separator: the login shell may be dash, whose kill builtin
  // rejects it; group ids are validated numerals.
  try {
    await execCapture(transport, `kill -${signal} ${groups.map((g) => `-${g}`).join(' ')}`);
  } catch (error: unknown) {
    if (!isConnLost(error)) throw error;
  }
}

/** Read a small remote text file; `undefined` when absent. */
export async function readRemoteFile(
  transport: RemoteTransport,
  path: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const { code, stdout } = await execCapture(transport, `cat -- ${sq(path)}`, signal);
  if (code !== 0) return undefined;
  return stdout;
}
