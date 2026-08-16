/**
 * Unit tests for SshSubprocessRuntime against the in-memory FakeTransport —
 * no real network. The fake re-implements the wrapper script semantics listed
 * in src/wrapper.ts ("Fake simulation contract").
 */
import { Buffer } from 'node:buffer';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import type { SubprocessSpawnSpec, SubprocessTerminalSpawnSpec } from '@dsh-remote/seams';
import { SshSubprocessRuntime } from '../src/index.js';
import type { SshSubprocessRuntimeOptions } from '../src/index.js';
import type { SshSubprocessHandle } from '../src/process.js';
import { FakeTransport } from './fake-transport.js';
import type { FakeTransportOptions } from './fake-transport.js';

const COLLECT = { maxBytes: 4096 };

function setup(fakeOptions: FakeTransportOptions = {}, runtimeOptions: Partial<SshSubprocessRuntimeOptions> = {}) {
  const ctx = new Context();
  const fake = new FakeTransport(fakeOptions);
  fake.mkdir('/runtime');
  fake.mkdir('/work');
  const holder: { current: FakeTransport | undefined } = { current: fake };
  const runtime = new SshSubprocessRuntime(ctx, {
    getTransport: () => holder.current,
    runtimeRoot: '/runtime',
    pollMs: 5,
    ...runtimeOptions,
  });
  return { ctx, fake, runtime, holder };
}

function spec(partial: Partial<SubprocessSpawnSpec> & { argv: readonly string[] }): SubprocessSpawnSpec {
  return {
    cwd: '/work',
    graceMs: 150,
    stdio: { stdin: 'ignore', stdout: COLLECT, stderr: COLLECT },
    ...partial,
  };
}

async function collectBytes(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

/** Wait until the remote wrapper has published the process group. */
async function untilStarted(handle: { pid: number }): Promise<number> {
  await vi.waitFor(() => expect(handle.pid).toBeGreaterThan(0));
  return handle.pid;
}

/** A program that parks until its group is KILLed. */
function foreverProgram() {
  return async (io: import('./fake-transport.js').FakeProgramIo) => {
    await new Promise<void>((resolve) => io.kill.addEventListener('abort', () => resolve(), { once: true }));
    return 0;
  };
}

describe('resolveExecutable', () => {
  it('verifies absolute paths with test -x', async () => {
    const { fake, runtime } = setup();
    fake.addProgram('/usr/bin/node', async () => 0);
    await expect(runtime.resolveExecutable('/usr/bin/node')).resolves.toBe('/usr/bin/node');
    await expect(runtime.resolveExecutable('/usr/bin/missing')).rejects.toThrow(/not found/);
  });

  it('resolves bare names against the scrubbed remote PATH', async () => {
    const { fake, runtime } = setup();
    fake.addProgram('/usr/bin/node', async () => 0);
    await expect(runtime.resolveExecutable('node')).resolves.toBe('/usr/bin/node');
    await expect(runtime.resolveExecutable('missing-cmd')).rejects.toThrow(/not found on remote PATH/);
  });

  it('honors explicit env PATH overrides for bare-name lookup', async () => {
    const { fake, runtime } = setup();
    fake.addProgram('/opt/tools/foo', async () => 0);
    await expect(runtime.resolveExecutable('foo', { PATH: '/opt/tools' })).resolves.toBe('/opt/tools/foo');
  });

  it('rejects relative paths containing separators', async () => {
    const { runtime } = setup();
    await expect(runtime.resolveExecutable('./local')).rejects.toThrow(/relative executable paths/);
    await expect(runtime.resolveExecutable('bin/tool')).rejects.toThrow(/relative executable paths/);
  });
});

describe('spawn: stdio modes', () => {
  it('pipe stdout/stderr deliver raw bytes unaltered (binary, split UTF-8)', async () => {
    const { fake, runtime } = setup();
    const outParts = [Buffer.from([0x00, 0x41, 0xe2]), Buffer.from([0x82, 0xac]), Buffer.from('tail\n')];
    const errParts = [Buffer.from('e1:'), Buffer.from([0xff, 0xfe])];
    fake.addProgram('/usr/bin/blob', async (io) => {
      for (const chunk of outParts) io.pushStdout(chunk);
      for (const chunk of errParts) io.pushStderr(chunk);
      return 3;
    });
    const handle = runtime.spawn(
      spec({ argv: ['/usr/bin/blob'], stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' } }),
    );
    const [out, err, outcome] = await Promise.all([
      collectBytes(handle.stdout!),
      collectBytes(handle.stderr!),
      handle.done,
    ]);
    expect(Buffer.compare(out, Buffer.concat(outParts))).toBe(0);
    expect(Buffer.compare(err, Buffer.concat(errParts))).toBe(0);
    expect(outcome).toEqual({ exitCode: 3, signal: null });
  });

  it('inherit writes child output to the harness process streams', async () => {
    const { fake, runtime } = setup();
    fake.addProgram('/usr/bin/hello', async (io) => {
      io.pushStdout('hello out\n');
      io.pushStderr('hello err\n');
      return 0;
    });
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const handle = runtime.spawn(
        spec({ argv: ['/usr/bin/hello'], stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' } }),
      );
      await handle.done;
      expect(outSpy.mock.calls.map((c) => String(c[0])).join('')).toContain('hello out');
      expect(errSpy.mock.calls.map((c) => String(c[0])).join('')).toContain('hello err');
    } finally {
      outSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it('collect keeps a bounded tail with offset reads and spill recovery', async () => {
    const { fake, runtime } = setup();
    fake.addProgram('/usr/bin/chatty', async (io) => {
      for (let i = 0; i < 5; i++) io.pushStdout(`${'x'.repeat(20)}${i}\n`); // 5 × 22 = 110 bytes
      return 0;
    });
    const handle = runtime.spawn(
      spec({
        argv: ['/usr/bin/chatty'],
        stdio: { stdin: 'ignore', stdout: { maxBytes: 30, spill: { maxBytes: 4096 } }, stderr: COLLECT },
      }),
    );
    await handle.done;
    const reader = handle.collected.stdout!;
    const read = reader.readFrom(0);
    expect(read.lossy).toBe(true);
    expect(read.text.length).toBe(30);
    expect(read.nextOffset).toBe(110);
    expect(read.spillPath).toMatch(/^\/runtime\/processes\/[0-9a-f]+\/stdout\.spill$/);
    // The remote spill holds the COMPLETE stream (consumers read it via ctx.fs).
    expect(new TextDecoder().decode(fake.readFile(read.spillPath!))).toHaveLength(110);
    // A second read from a valid offset is lossless.
    const tail = reader.readFrom(80);
    expect(tail.lossy).toBe(false);
    expect(tail.text.length).toBe(30);
  });

  it('collect without spill reports lossy reads with no spillPath', async () => {
    const { fake, runtime } = setup();
    fake.addProgram('/usr/bin/chatty', async (io) => {
      io.pushStdout('a'.repeat(100));
      return 0;
    });
    const handle = runtime.spawn(
      spec({ argv: ['/usr/bin/chatty'], stdio: { stdin: 'ignore', stdout: { maxBytes: 10 }, stderr: COLLECT } }),
    );
    await handle.done;
    const read = handle.collected.stdout!.readFrom(0);
    expect(read.lossy).toBe(true);
    expect(read.text).toBe('a'.repeat(10));
    expect(read.spillPath).toBeUndefined();
  });

  it('drops the remote spill when the stream outgrew the spill cap', async () => {
    const { fake, runtime } = setup();
    fake.addProgram('/usr/bin/chatty', async (io) => {
      io.pushStdout('b'.repeat(100));
      return 0;
    });
    const handle = runtime.spawn(
      spec({
        argv: ['/usr/bin/chatty'],
        stdio: { stdin: 'ignore', stdout: { maxBytes: 10, spill: { maxBytes: 20 } }, stderr: COLLECT },
      }),
    );
    const spillPath = `/runtime/processes/${(handle as SshSubprocessHandle).id}/stdout.spill`;
    await handle.done;
    const read = handle.collected.stdout!.readFrom(0);
    expect(read.lossy).toBe(true);
    expect(read.spillPath).toBeUndefined(); // incomplete spill is never advertised
    await vi.waitFor(() => expect(fake.exists(spillPath)).toBe(false));
  });

  it('collect readers stay readable after exit and track offsets incrementally', async () => {
    const { fake, runtime } = setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    fake.addProgram('/usr/bin/pieces', async (io) => {
      io.pushStdout('abc');
      await gate;
      io.pushStdout('def');
      return 0;
    });
    const handle = runtime.spawn(spec({ argv: ['/usr/bin/pieces'] }));
    const reader = handle.collected.stdout!;
    await vi.waitFor(() => expect(reader.readFrom(0).text).toBe('abc'));
    const first = reader.readFrom(0);
    release();
    await handle.done;
    const second = reader.readFrom(first.nextOffset);
    expect(second.text).toBe('def');
    expect(second.lossy).toBe(false);
    expect(reader.readFrom(0).text).toBe('abcdef');
  });
});

describe('spawn: stdin modes', () => {
  it("'pipe' streams caller writes to the child's stdin", async () => {
    const { fake, runtime } = setup();
    fake.addProgram('/usr/bin/cat', async (io) => {
      for await (const chunk of io.stdin) io.pushStdout(chunk);
      return 0;
    });
    const handle = runtime.spawn(
      spec({ argv: ['/usr/bin/cat'], stdio: { stdin: 'pipe', stdout: COLLECT, stderr: COLLECT } }),
    );
    handle.stdin!.write('first-');
    handle.stdin!.end('second');
    await handle.done;
    expect(handle.collected.stdout!.readFrom(0).text).toBe('first-second');
  });

  it('{ data } writes the batch bytes and closes stdin', async () => {
    const { fake, runtime } = setup();
    fake.addProgram('/usr/bin/cat', async (io) => {
      for await (const chunk of io.stdin) io.pushStdout(chunk);
      return 0;
    });
    const handle = runtime.spawn(
      spec({ argv: ['/usr/bin/cat'], stdio: { stdin: { data: 'batch-bytes' }, stdout: COLLECT, stderr: COLLECT } }),
    );
    await handle.done;
    expect(handle.collected.stdout!.readFrom(0).text).toBe('batch-bytes');
    expect(handle.stdin).toBeUndefined();
  });

  it("'ignore' leaves the child reading EOF immediately", async () => {
    const { fake, runtime } = setup();
    fake.addProgram('/usr/bin/cat', async (io) => {
      let got = 0;
      for await (const chunk of io.stdin) got += chunk.length;
      io.pushStdout(`bytes:${got}`);
      return 0;
    });
    const handle = runtime.spawn(spec({ argv: ['/usr/bin/cat'] }));
    const outcome = await handle.done;
    expect(outcome.exitCode).toBe(0);
    expect(handle.collected.stdout!.readFrom(0).text).toBe('bytes:0');
  });
});

describe('spawn: exit facts, env, and failures', () => {
  it('reports exit codes from the wrapper status', async () => {
    const { fake, runtime } = setup();
    fake.addProgram('/usr/bin/seven', async () => 7);
    const handle = runtime.spawn(spec({ argv: ['/usr/bin/seven'] }));
    await expect(handle.done).resolves.toEqual({ exitCode: 7, signal: null });
    expect(handle.pid).toBeGreaterThan(0);
  });

  it('a missing executable is a normal outcome (exit 127), not a spawn failure', async () => {
    const { runtime } = setup();
    const handle = runtime.spawn(spec({ argv: ['/usr/bin/not-there'] }));
    const outcome = await handle.done;
    expect(outcome).toEqual({ exitCode: 127, signal: null });
    expect(handle.collected.stderr!.readFrom(0).text).toContain('No such file or directory');
  });

  it('a missing cwd is a spawn-level failure: done rejects, pid stays -1', async () => {
    const { runtime } = setup();
    const handle = runtime.spawn(spec({ argv: ['/usr/bin/true'], cwd: '/no/such/dir' }));
    await expect(handle.done).rejects.toThrow(/remote spawn failed/);
    expect(handle.pid).toBe(-1);
  });

  it('passes explicit env entries and honors undefined tombstones', async () => {
    const { fake, runtime } = setup();
    fake.addProgram('/usr/bin/envdump', async (io) => {
      io.pushStdout(`MY_VAR=${io.env.MY_VAR ?? '<unset>'} HOME=${io.env.HOME ?? '<unset>'} PATH=${io.env.PATH ?? '<unset>'}`);
      return 0;
    });
    const handle = runtime.spawn(spec({ argv: ['/usr/bin/envdump'], env: { MY_VAR: 'yes', HOME: undefined } }));
    await handle.done;
    const text = handle.collected.stdout!.readFrom(0).text;
    expect(text).toContain('MY_VAR=yes');
    expect(text).toContain('HOME=<unset>'); // tombstone removed the ambient entry
    expect(text).toContain('PATH=/usr/bin:/bin'); // scrubbed remote baseline survives
  });
});

describe('terminate / waitForExit', () => {
  it('escalates TERM → grace → KILL for a group that traps TERM, idempotently', async () => {
    const { fake, runtime } = setup();
    fake.addProgram('/usr/bin/stubborn', async (io) => {
      io.trapTerm = true;
      await new Promise<void>((resolve) => io.kill.addEventListener('abort', () => resolve(), { once: true }));
      return 0;
    });
    const handle = runtime.spawn(spec({ argv: ['/usr/bin/stubborn'], graceMs: 80 }));
    const pgid = await untilStarted(handle);
    handle.terminate();
    handle.terminate(); // idempotent: a single escalation ladder
    await vi.waitFor(() => {
      expect(fake.deliveredSignals.filter((s) => s.pgid === pgid && s.signal === 'SIGTERM')).toHaveLength(1);
    });
    const outcome = await handle.done;
    expect(fake.deliveredSignals.filter((s) => s.pgid === pgid && s.signal === 'SIGKILL')).toHaveLength(1);
    expect(outcome).toEqual({ exitCode: null, signal: 'SIGKILL' });
    await expect(handle.waitForExit()).resolves.toBe(true);
  });

  it('a plain process dies on TERM and reports the signal', async () => {
    const { fake, runtime } = setup();
    fake.addProgram('/usr/bin/forever', foreverProgram());
    const handle = runtime.spawn(spec({ argv: ['/usr/bin/forever'] }));
    await untilStarted(handle);
    handle.terminate();
    await expect(handle.done).resolves.toEqual({ exitCode: null, signal: 'SIGTERM' });
  });

  it('waitForExit observes the whole tree, not just the direct child', async () => {
    const { fake, runtime } = setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    fake.addProgram('/usr/bin/spawner', async (io) => {
      io.addGroupMember(gate);
      return 0; // the direct child exits; the descendant lingers
    });
    const handle = runtime.spawn(spec({ argv: ['/usr/bin/spawner'] }));
    await handle.done; // direct child done
    await expect(handle.waitForExit(AbortSignal.timeout(80))).resolves.toBe(false); // descendant still live
    release();
    await expect(handle.waitForExit(AbortSignal.timeout(5_000))).resolves.toBe(true);
  });

  it('the spec abort signal starts the same termination ladder', async () => {
    const { fake, runtime } = setup();
    fake.addProgram('/usr/bin/forever', foreverProgram());
    const controller = new AbortController();
    const handle = runtime.spawn(spec({ argv: ['/usr/bin/forever'], signal: controller.signal }));
    await untilStarted(handle);
    controller.abort();
    await expect(handle.done).resolves.toEqual({ exitCode: null, signal: 'SIGTERM' });
  });
});

describe('concurrency, disposal, and connection loss', () => {
  it('concurrent handles never cross their frame streams', async () => {
    const { fake, runtime } = setup();
    for (const name of ['a', 'b']) {
      fake.addProgram(`/usr/bin/tag-${name}`, async (io) => {
        for (let i = 0; i < 20; i++) {
          io.pushStdout(`${name}${i};`);
          await new Promise((r) => setTimeout(r, 1));
        }
        return name === 'a' ? 0 : 1;
      });
    }
    const ha = runtime.spawn(spec({ argv: ['/usr/bin/tag-a'] }));
    const hb = runtime.spawn(spec({ argv: ['/usr/bin/tag-b'] }));
    const [oa, ob] = await Promise.all([ha.done, hb.done]);
    expect(oa.exitCode).toBe(0);
    expect(ob.exitCode).toBe(1);
    expect(ha.collected.stdout!.readFrom(0).text).toBe(Array.from({ length: 20 }, (_, i) => `a${i};`).join(''));
    expect(hb.collected.stdout!.readFrom(0).text).toBe(Array.from({ length: 20 }, (_, i) => `b${i};`).join(''));
  });

  it('disposing the service terminates surviving groups and awaits exit', async () => {
    const ctx = new Context();
    const fake = new FakeTransport();
    fake.mkdir('/runtime');
    fake.mkdir('/work');
    let killed = false;
    fake.addProgram('/usr/bin/forever', async (io) => {
      await new Promise<void>((resolve) =>
        io.kill.addEventListener(
          'abort',
          () => {
            killed = true;
            resolve();
          },
          { once: true },
        ),
      );
      return 0;
    });
    const fiber = await ctx.plugin(SshSubprocessRuntime, {
      getTransport: () => fake,
      runtimeRoot: '/runtime',
      pollMs: 5,
    });
    const handle = ctx.subprocess.spawn(spec({ argv: ['/usr/bin/forever'] }));
    await vi.waitFor(() => expect(handle.pid).toBeGreaterThan(0));
    await fiber.dispose();
    expect(killed).toBe(true);
    await expect(handle.done).resolves.toEqual({ exitCode: null, signal: 'SIGTERM' });
  });

  it('a lost connection settles live handles with an infrastructure failure', async () => {
    const { fake, runtime } = setup();
    fake.addProgram('/usr/bin/forever', foreverProgram());
    const handle = runtime.spawn(spec({ argv: ['/usr/bin/forever'] }));
    await untilStarted(handle);
    await fake.close();
    await expect(handle.done).rejects.toThrow(/connection lost/);
    await expect(handle.waitForExit()).resolves.toBe(true);
  });
});

describe('spawnTerminal', () => {
  function termSpec(over: Partial<SubprocessTerminalSpawnSpec> = {}): SubprocessTerminalSpawnSpec {
    return { argv: ['/bin/fakesh'], cwd: '/work', rows: 24, cols: 80, graceMs: 150, ...over };
  }

  function addShell(fake: FakeTransport): void {
    fake.addTerminalProgram('/bin/fakesh', async (io) => {
      io.onSignal = () => {};
      io.write('$ ');
      io.setInputWaiting(true);
      for await (const chunk of io.input) {
        io.setInputWaiting(false);
        io.write(chunk);
        io.write('$ ');
        io.setInputWaiting(true);
      }
      return 0;
    });
  }

  it('allocates a PTY, strips bootstrap bytes, and round-trips input', async () => {
    const { fake, runtime } = setup();
    addShell(fake);
    const term = await runtime.spawnTerminal(termSpec());
    expect(term.pid).toBeGreaterThan(0);
    const collected: Buffer[] = [];
    void (async () => {
      for await (const chunk of term.output) collected.push(Buffer.from(chunk as Uint8Array));
    })();
    await vi.waitFor(() => expect(Buffer.concat(collected).toString()).toContain('$ '));
    await term.write('echo hi\r');
    await vi.waitFor(() => expect(Buffer.concat(collected).toString()).toContain('echo hi'));
    expect(Buffer.concat(collected).toString()).not.toContain('dsh-ssh-bootstrap');
    await term.terminate();
    await expect(term.done).resolves.toEqual({ exitCode: null, signal: 'SIGTERM' });
  });

  it('reports the foreground process group and best-effort input-wait state', async () => {
    const { fake, runtime } = setup();
    addShell(fake);
    const term = await runtime.spawnTerminal(termSpec());
    const fg = await term.inspectForeground();
    expect(fg).toBeDefined();
    expect(fg!.processGroupId).toBe(term.pid);
    expect(fg!.inputWaiting).toBe(true);
    await term.terminate();
  });

  it('delivers signals to the foreground group', async () => {
    const { fake, runtime } = setup();
    let got: string | undefined;
    fake.addTerminalProgram('/bin/fakesh', async (io) => {
      io.onSignal = (sig) => {
        got = sig;
      };
      await new Promise<void>((resolve) => io.term.addEventListener('abort', () => resolve(), { once: true }));
      return 0;
    });
    const term = await runtime.spawnTerminal(termSpec());
    const pgid = await term.signalForeground('SIGINT');
    expect(pgid).toBe(term.pid);
    expect(got).toBe('SIGINT');
    expect(fake.deliveredSignals).toContainEqual({ pgid, signal: 'SIGINT' });
    await term.terminate();
  });

  it('terminate escalates to KILL for a session that traps TERM', async () => {
    const { fake, runtime } = setup();
    fake.addTerminalProgram('/bin/fakesh', async (io) => {
      io.trapTerm = true;
      await new Promise<void>((resolve) => io.kill.addEventListener('abort', () => resolve(), { once: true }));
      return 0;
    });
    const term = await runtime.spawnTerminal(termSpec({ graceMs: 60 }));
    await term.terminate();
    await expect(term.done).resolves.toEqual({ exitCode: null, signal: 'SIGKILL' });
    await term.terminate(); // idempotent: same settled cleanup
  });

  it('a missing terminal program is a normal outcome after allocation', async () => {
    const { runtime } = setup();
    const term = await runtime.spawnTerminal(termSpec({ argv: ['/bin/not-a-shell'] }));
    await expect(term.done).resolves.toEqual({ exitCode: 127, signal: null });
  });

  it('negotiates the spec window size and TERM via the pty request', async () => {
    const { fake, runtime } = setup();
    addShell(fake);
    const term = await runtime.spawnTerminal(termSpec({ rows: 30, cols: 100 }));
    // TERM comes from the (fake) login environment.
    expect(fake.lastTerminalPty).toEqual({ rows: 30, cols: 100, term: 'xterm-256color' });
    await term.terminate();
  });

  it('an explicit TERM in the spec env wins over the default', async () => {
    const { fake, runtime } = setup();
    addShell(fake);
    const term = await runtime.spawnTerminal(termSpec({ env: { TERM: 'xterm-kitty' } }));
    expect(fake.lastTerminalPty).toEqual({ rows: 24, cols: 80, term: 'xterm-kitty' });
    await term.terminate();
  });

  it('an aborted allocation signal rejects before publishing a handle', async () => {
    const { fake, runtime } = setup();
    addShell(fake);
    const controller = new AbortController();
    controller.abort();
    await expect(runtime.spawnTerminal(termSpec({ signal: controller.signal }))).rejects.toThrow();
  });
});
