/**
 * End-to-end integration test: real sshd (Alpine container, key auth) →
 * SshTransport → SshRemoteHub (ctx.remoteHub) → SshSubprocessRuntime
 * (ctx.subprocess provider).
 *
 * Gated on DSH_TEST_SSH_HOST: without the env vars (CI / bare `pnpm test`)
 * the whole suite is skipped. Bring up the container with:
 *
 *   eval "$(integration/run-sshd.sh start)"
 *   pnpm vitest run tests/integration
 *
 * All remote filesystem writes go to /home/dsh/tmp-it-sub/ (created in
 * beforeAll, removed in afterAll); the wrapper's private state lives under
 * the per-connection runtime root, removed by the hub on disconnect.
 */
import { Buffer } from 'node:buffer';
import type { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import RemoteHubPlugin from '@dsh-remote/remote-ssh';
import type { RemoteHub, RemoteTransport } from '@dsh-remote/remote';
import type { SubprocessSpawnSpec } from '@dsh-remote/seams';
import { SshSubprocessRuntime } from '../../src/index.js';

const HOST = process.env.DSH_TEST_SSH_HOST;
const PORT = Number(process.env.DSH_TEST_SSH_PORT ?? '22');
const USER = process.env.DSH_TEST_SSH_USER ?? 'dsh';
const KEY = process.env.DSH_TEST_SSH_KEY ?? '';

const TMP = '/home/dsh/tmp-it-sub';
const COLLECT = { maxBytes: 64 * 1024 };

async function collectBytes(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

describe.skipIf(!HOST)('live sshd integration (subprocess-ssh)', { timeout: 60_000 }, () => {
  let ctx: Context;
  let fiber: { dispose(): Promise<void> };
  let hub: RemoteHub;
  let transport: RemoteTransport;
  let runtime: SshSubprocessRuntime;
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

  function spec(partial: Partial<SubprocessSpawnSpec> & { argv: readonly string[] }): SubprocessSpawnSpec {
    return {
      cwd: '/home/dsh',
      graceMs: 2_000,
      stdio: { stdin: 'ignore', stdout: COLLECT, stderr: COLLECT },
      ...partial,
    };
  }

  /** Wait until the remote wrapper has published the process group. */
  async function untilStarted(handle: { pid: number }): Promise<number> {
    await vi.waitFor(() => expect(handle.pid).toBeGreaterThan(0), { timeout: 15_000 });
    return handle.pid;
  }

  beforeAll(async () => {
    ctx = new Context();
    fiber = await ctx.plugin(RemoteHubPlugin, {
      // TEST-ONLY: the target is a throwaway localhost container whose host
      // key changes on every rebuild, so pinning it is meaningless here.
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
    runtime = new SshSubprocessRuntime(ctx, {
      getTransport: () => hub.get(targetId),
      runtimeRoot: () => hub.runtimeRoot(targetId),
      pollMs: 25,
    });
    const { code, stderr } = await execSh(`mkdir -p ${TMP}`);
    if (code !== 0) throw new Error(`failed to create ${TMP}: ${stderr}`);
  }, 60_000);

  afterAll(async () => {
    try {
      if (transport) await execSh(`rm -rf ${TMP}`);
    } catch {
      /* the disconnect test may leave the transport down; residue is in the container */
    } finally {
      await hub?.disconnect(targetId);
      await fiber?.dispose();
    }
  }, 30_000);

  describe('resolveExecutable', () => {
    it('verifies an absolute path', async () => {
      await expect(runtime.resolveExecutable('/bin/bash')).resolves.toBe('/bin/bash');
      await expect(runtime.resolveExecutable('/bin/missing-xyz')).rejects.toThrow(/not found or not executable/);
    });

    it('resolves a bare name against the remote PATH', async () => {
      await expect(runtime.resolveExecutable('sh')).resolves.toMatch(/\/sh$/);
    });

    it('rejects relative paths containing separators', async () => {
      await expect(runtime.resolveExecutable('./local')).rejects.toThrow(/relative executable paths/);
      await expect(runtime.resolveExecutable('bin/tool')).rejects.toThrow(/relative executable paths/);
    });

    it('rejects a bare name missing from the remote PATH', async () => {
      await expect(runtime.resolveExecutable('definitely-not-a-command-xyz')).rejects.toThrow(
        /not found on remote PATH/,
      );
    });
  });

  describe('spawn: collect mode', () => {
    it('collects stdout/stderr and settles with the exit facts', async () => {
      const handle = runtime.spawn(spec({ argv: ['sh', '-c', 'echo out; echo err >&2'] }));
      const outcome = await handle.done;
      expect(outcome).toEqual({ exitCode: 0, signal: null });
      const out = handle.collected.stdout!.readFrom(0);
      const err = handle.collected.stderr!.readFrom(0);
      expect(out).toMatchObject({ text: 'out\n', lossy: false });
      expect(err).toMatchObject({ text: 'err\n', lossy: false });
      expect(out.nextOffset).toBe(4);
    });

    it('done settles only after the collected tail is fully drained', async () => {
      // The trailing bytes arrive just before exit; the END frame follows the
      // remote encoder drain, so readFrom(0) after done must see them.
      const handle = runtime.spawn(spec({ argv: ['sh', '-c', 'printf head; sleep 0.3; printf tail-end'] }));
      await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null });
      expect(handle.collected.stdout!.readFrom(0).text).toBe('headtail-end');
    });
  });

  describe('spawn: pipe mode', () => {
    it('round-trips multibyte and binary stdin bytes through cat verbatim', async () => {
      const payload = Buffer.concat([
        Buffer.from('héllo 世界 — multibyte\n', 'utf8'),
        Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x7f]),
        Buffer.from('tail-line\n', 'utf8'),
      ]);
      const handle = runtime.spawn(
        spec({ argv: ['cat'], stdio: { stdin: 'pipe', stdout: 'pipe', stderr: COLLECT } }),
      );
      const echoed = collectBytes(handle.stdout!);
      handle.stdin!.write(payload.subarray(0, 10));
      handle.stdin!.write(payload.subarray(10));
      handle.stdin!.end();
      const [bytes, outcome] = await Promise.all([echoed, handle.done]);
      expect(Buffer.compare(bytes, payload)).toBe(0);
      expect(outcome).toEqual({ exitCode: 0, signal: null });
    });
  });

  describe('spawn: batch stdin', () => {
    it('writes {data} and closes stdin', async () => {
      const data = 'batch-stdin-payload\nsecond line\n';
      const handle = runtime.spawn(
        spec({ argv: ['wc', '-c'], stdio: { stdin: { data }, stdout: COLLECT, stderr: COLLECT } }),
      );
      await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null });
      expect(handle.collected.stdout!.readFrom(0).text.trim()).toBe(String(Buffer.byteLength(data)));
    });
  });

  describe('spawn: large output with spill', () => {
    it('reports a lossy tail and keeps the complete stream in the remote spill file', async () => {
      const rawBytes = 307_200;
      const handle = runtime.spawn(
        spec({
          argv: ['sh', '-c', `head -c ${rawBytes} /dev/urandom | base64`],
          stdio: {
            stdin: 'ignore',
            stdout: { maxBytes: 4096, spill: { maxBytes: 2 * 1024 * 1024 } },
            stderr: COLLECT,
          },
        }),
      );
      await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null });
      const read = handle.collected.stdout!.readFrom(0);
      expect(read.lossy).toBe(true);
      // GNU base64 wraps at 76 columns: rawBytes/3*4 chars plus newlines.
      const total = read.nextOffset;
      expect(total).toBe((rawBytes / 3) * 4 + Math.ceil(((rawBytes / 3) * 4) / 76));
      // The retained tail respects the in-memory cap.
      expect(Buffer.byteLength(read.text)).toBeLessThanOrEqual(4096);
      // The remote spill file holds the complete stream.
      expect(read.spillPath).toBeDefined();
      const { code, stdout } = await execSh(`stat -c %s ${read.spillPath!}`);
      expect(code).toBe(0);
      expect(Number(stdout.trim())).toBe(total);
    });
  });

  describe('termination', () => {
    it('terminate() kills the whole process tree without orphans', async () => {
      const handle = runtime.spawn(spec({ argv: ['sh', '-c', 'sleep 100 & sleep 200 & wait'] }));
      await untilStarted(handle);
      handle.terminate();
      const outcome = await handle.done;
      expect(outcome.exitCode).toBeNull();
      expect(outcome.signal).toMatch(/^SIG(TERM|KILL)$/);
      await expect(handle.waitForExit()).resolves.toBe(true);
      // No sleep from this tree may survive as an orphan.
      const { stdout } = await execSh("ps -eo args= | grep -E 'sleep (100|200)$' || true");
      expect(stdout.trim()).toBe('');
    });

    it('the spec abort signal terminates the process tree', async () => {
      const controller = new AbortController();
      const handle = runtime.spawn(
        spec({ argv: ['sh', '-c', 'sleep 300'], signal: controller.signal }),
      );
      await untilStarted(handle);
      controller.abort();
      const outcome = await handle.done;
      expect(outcome.exitCode).toBeNull();
      expect(outcome.signal).toMatch(/^SIG(TERM|KILL)$/);
      await expect(handle.waitForExit()).resolves.toBe(true);
      const { stdout } = await execSh("ps -eo args= | grep -E 'sleep 300$' || true");
      expect(stdout.trim()).toBe('');
    });
  });

  describe('terminal', () => {
    it('negotiates the requested window size with the remote pty', async () => {
      const terminal = await runtime.spawnTerminal({
        argv: ['sh'],
        cwd: '/home/dsh',
        rows: 30,
        cols: 100,
        graceMs: 2_000,
      });
      let received = '';
      terminal.output.on('data', (chunk: Uint8Array) => {
        received += Buffer.from(chunk).toString('utf8');
      });
      try {
        await terminal.write('stty size\n');
        await vi.waitFor(() => expect(received).toMatch(/30 100\r?\n/), { timeout: 15_000 });
      } finally {
        await terminal.terminate();
      }
    });

    it('allocates a PTY, drives the foreground group, and terminates idempotently', async () => {
      const terminal = await runtime.spawnTerminal({
        argv: ['sh'],
        cwd: '/home/dsh',
        rows: 24,
        cols: 80,
        graceMs: 2_000,
      });
      let received = '';
      terminal.output.on('data', (chunk: Uint8Array) => {
        received += Buffer.from(chunk).toString('utf8');
      });
      try {
        expect(terminal.pid).toBeGreaterThan(0);
        // Drive the shell: the executed reply is R<term>; the tty's own echo
        // of the input line contains R<%s>, which the pattern excludes.
        await terminal.write("printf 'R<%s>\\n' \"$TERM\"\n");
        await vi.waitFor(() => expect(received).toMatch(/R<[^%\r\n]+>/), { timeout: 15_000 });
        // The foreground group is the interactive shell itself, waiting on input.
        const foreground = await terminal.inspectForeground();
        expect(foreground).toBeDefined();
        expect(foreground!.processGroupId).toBeGreaterThan(0);
        // SIGINT to an idle interactive sh is absorbed; the group id comes back.
        const signaled = await terminal.signalForeground('SIGINT');
        expect(signaled).toBe(foreground!.processGroupId);
      } finally {
        // terminate() is idempotent and awaits whole-session quiescence.
        await Promise.all([terminal.terminate(), terminal.terminate()]);
      }
      await expect(terminal.done).resolves.toMatchObject({ exitCode: null });
      await expect(terminal.terminate()).resolves.toBeUndefined();
      // No session member survives the teardown.
      const { stdout } = await execSh(
        `ps -eo sid=,args= | awk '$1 == ${terminal.pid} && $2 != "ps"'`,
      );
      expect(stdout.trim()).toBe('');
    });
  });

  describe('connection loss', () => {
    it('settles a live handle with failure semantics after disconnect (no hang)', async () => {
      const handle = runtime.spawn(spec({ argv: ['sh', '-c', 'sleep 300'] }));
      await untilStarted(handle);
      await hub.disconnect(targetId);
      // The channel is gone and the status file unreadable: done must reject
      // with connection-lost semantics rather than hang.
      await expect(handle.done).rejects.toThrow(/connection lost/);
      await expect(handle.waitForExit()).resolves.toBe(true);
      // Reconnect for the remaining tests and for afterAll cleanup.
      transport = await hub.connect(targetId);
      expect(hub.status(targetId)).toBe('connected');
    });
  });
});
