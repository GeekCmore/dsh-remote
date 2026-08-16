/**
 * In-memory fake of the `RemoteTransport` contract for subprocess-ssh tests:
 * a minimal remote file tree plus a bash-semantics simulator that understands
 * exactly the provider's exec inventory (see the "Fake simulation contract"
 * list in src/wrapper.ts). Any other command exits 127 so tests notice
 * unexpected exec traffic.
 *
 * The spawn/terminal wrapper scripts are NOT executed; the fake re-implements
 * their documented semantics in JS (header parsing, pgid/status files,
 * base64 framing, spill caps, START/END frames, signal delivery).
 */
import { Buffer } from 'node:buffer';
import { posix } from 'node:path';
import { TransportError } from '@dsh-remote/remote';
import type { ExecOptions, ExecProcess, RemoteTransport } from '@dsh-remote/remote';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface FakeProgramIo {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  pgid: number;
  stdin: AsyncIterable<Uint8Array>;
  pushStdout(chunk: Uint8Array | string): void;
  pushStderr(chunk: Uint8Array | string): void;
  /** Fires when the process group receives SIGTERM (only useful with trapTerm). */
  term: AbortSignal;
  /** Fires on SIGKILL; the process is dead regardless of what it does next. */
  kill: AbortSignal;
  /** Set true to survive SIGTERM; the program must exit on its own or be KILLed. */
  trapTerm: boolean;
  /** Keep the process tree alive after the main program returns (descendant). */
  addGroupMember(p: Promise<unknown>): void;
}

export type FakeProgram = (io: FakeProgramIo) => Promise<number | void>;

export interface FakeTerminalIo {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  input: AsyncIterable<Uint8Array>;
  write(chunk: Uint8Array | string): void;
  term: AbortSignal;
  kill: AbortSignal;
  trapTerm: boolean;
  setInputWaiting(waiting: boolean): void;
  /** Non-fatal signals delivered to the foreground group (INT/TSTP/HUP). */
  onSignal?: (signal: string) => void;
}

export type FakeTerminalProgram = (io: FakeTerminalIo) => Promise<number | void>;

interface FakeProc {
  pgid: number;
  kind: 'spawn' | 'terminal';
  alive: boolean;
  dead: boolean;
  members: { promise: Promise<unknown>; pending: boolean }[];
  tty?: string;
  inputWaiting: boolean;
  termCtl: AbortController;
  killCtl: AbortController;
  trapTerm: boolean;
  onSignal?: (signal: string) => void;
  /** `force` models signal death: the whole group is gone, members included. */
  finish(status: string, code: number | null, signal?: string, force?: boolean): void;
}

/** Promise-queue-backed async iterable for channel streams. */
class PushQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: ((result: IteratorResult<T>) => void)[] = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

/** One simulated exec channel. */
class FakeChannel {
  readonly outQueue = new PushQueue<Uint8Array>();
  readonly errQueue = new PushQueue<Uint8Array>();
  readonly stdinQueue = new PushQueue<Uint8Array>();
  onKill: (() => void) | undefined;
  private doneResolve!: (result: { code: number | null; signal?: string }) => void;
  readonly donePromise = new Promise<{ code: number | null; signal?: string }>((res) => {
    this.doneResolve = res;
  });

  process(): ExecProcess {
    return {
      stdout: this.outQueue,
      stderr: this.errQueue,
      write: (data) => this.stdinQueue.push(typeof data === 'string' ? encoder.encode(data) : data),
      endStdin: () => this.stdinQueue.close(),
      done: this.donePromise,
      kill: () => {
        this.onKill?.();
        this.forceClose(null);
        return Promise.resolve();
      },
    };
  }

  forceClose(code: number | null, signal?: string): void {
    this.outQueue.close();
    this.errQueue.close();
    this.stdinQueue.close();
    this.doneResolve(signal ? { code, signal } : { code });
  }
}

/** Line-oriented header reader over channel stdin; the remainder stays byte-faithful. */
class StdinReader {
  private text = '';
  private readonly iterator: AsyncIterator<Uint8Array>;

  constructor(private readonly queue: PushQueue<Uint8Array>) {
    this.iterator = queue[Symbol.asyncIterator]();
  }

  async nextLine(): Promise<string | undefined> {
    for (;;) {
      const idx = this.text.indexOf('\n');
      if (idx >= 0) {
        const line = this.text.slice(0, idx);
        this.text = this.text.slice(idx + 1);
        return line;
      }
      const next = await this.iterator.next();
      if (next.done) return undefined;
      this.text += decoder.decode(next.value, { stream: true });
    }
  }

  async *rest(): AsyncIterable<Uint8Array> {
    if (this.text.length > 0) {
      yield encoder.encode(this.text);
      this.text = '';
    }
    for await (const chunk of this.queue) yield chunk;
  }
}

/** Tokenize a command line of POSIX single-quoted and bare tokens. */
export function parseTokens(input: string): string[] {
  const tokens: string[] = [];
  const s = input.trim();
  let i = 0;
  while (i < s.length) {
    while (i < s.length && s[i] === ' ') i++;
    if (i >= s.length) break;
    let token = '';
    while (i < s.length && s[i] !== ' ') {
      if (s[i] === "'") {
        // Quoted segment: literal up to the next quote.
        i++;
        const end = s.indexOf("'", i);
        if (end < 0) throw new Error(`fake parseTokens: unterminated quote in ${input.slice(0, 80)}…`);
        token += s.slice(i, end);
        i = end + 1;
      } else if (s[i] === '\\' && s[i + 1] === "'") {
        // sq() emits a literal quote as close-escape-reopen: '\'' .
        token += "'";
        i += 2;
      } else {
        token += s[i];
        i++;
      }
    }
    tokens.push(token);
  }
  return tokens;
}

export interface FakeTransportOptions {
  /** Login environment served by probeLoginEnv and used as default PATH source. */
  loginEnv?: Record<string, string>;
  /** Called with every exec command before it is handled (race injection). */
  onExec?: (command: string) => void;
}

export class FakeTransport implements RemoteTransport {
  private readonly files = new Map<string, Uint8Array>();
  private readonly dirs = new Set<string>(['/']);
  private readonly programs = new Map<string, FakeProgram>();
  private readonly terminalPrograms = new Map<string, FakeTerminalProgram>();
  private readonly procs = new Map<number, FakeProc>();
  private nextPgid = 10_000;
  private nextTty = 0;
  private readonly loginEnv: Record<string, string>;
  private readonly onExec?: (command: string) => void;
  private readonly channels = new Set<FakeChannel>();
  /** Signals delivered to process groups, for assertions. */
  readonly deliveredSignals: { pgid: number; signal: string }[] = [];
  closed = false;
  execCount = 0;
  /** The `pty` option of the most recent terminal-wrapper exec, for assertions. */
  lastTerminalPty?: ExecOptions['pty'];

  constructor(options: FakeTransportOptions = {}) {
    this.loginEnv = options.loginEnv ?? {
      HOME: '/home/fake',
      PATH: '/usr/bin:/bin',
      TERM: 'xterm-256color',
      USER: 'fake',
      SHELL: '/bin/bash',
    };
    this.onExec = options.onExec;
  }

  // ------------------------------------------------------------ test helpers

  addProgram(path: string, program: FakeProgram): void {
    this.programs.set(path, program);
  }

  addTerminalProgram(path: string, program: FakeTerminalProgram): void {
    this.terminalPrograms.set(path, program);
  }

  mkdir(path: string): void {
    this.mkdirp(path);
  }

  writeFile(path: string, content: string | Uint8Array): void {
    this.mkdirp(posix.dirname(path));
    this.files.set(path, typeof content === 'string' ? encoder.encode(content) : content.slice());
  }

  readFile(path: string): Uint8Array | undefined {
    return this.files.get(path)?.slice();
  }

  exists(path: string): boolean {
    return this.files.has(path) || this.dirs.has(path);
  }

  groupAlive(pgid: number): boolean {
    const proc = this.procs.get(pgid);
    if (!proc || proc.dead) return false;
    return proc.alive || proc.members.some((m) => m.pending);
  }

  private mkdirp(path: string): void {
    const parts = posix.normalize(path).split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current += `/${part}`;
      this.dirs.add(current);
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new TransportError('connection lost', 'CONN_LOST');
  }

  private resolveProgram(argv0: string, envPath: string | undefined): FakeProgram | undefined {
    if (argv0.startsWith('/')) return this.programs.get(argv0);
    const dirs = (envPath ?? this.loginEnv.PATH ?? '/usr/bin:/bin').split(':').filter(Boolean);
    for (const dir of dirs) {
      const program = this.programs.get(`${dir}/${argv0}`);
      if (program) return program;
    }
    return undefined;
  }

  // ---------------------------------------------------------- RemoteTransport

  sftp(): Promise<never> {
    return Promise.reject(new TransportError('subprocess-ssh fake has no sftp', 'IO_ERROR'));
  }

  probeLoginEnv(vars: string[]): Promise<Record<string, string>> {
    this.assertOpen();
    const env: Record<string, string> = {};
    for (const v of vars) env[v] = this.loginEnv[v] ?? '';
    return Promise.resolve(env);
  }

  close(): Promise<void> {
    this.closed = true;
    for (const channel of this.channels) channel.forceClose(null);
    return Promise.resolve();
  }

  exec(command: string, opts: ExecOptions = {}): Promise<ExecProcess> {
    this.assertOpen();
    this.execCount++;
    this.onExec?.(command);
    try {
      return Promise.resolve(this.dispatch(command, opts));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private dispatch(command: string, opts: ExecOptions): ExecProcess {
    const channel = new FakeChannel();
    this.channels.add(channel);
    void channel.donePromise.finally(() => this.channels.delete(channel));

    if (command.startsWith("bash -c '")) {
      const tokens = parseTokens(command.slice('bash -c '.length));
      const [script, , id, root] = tokens as [string, string, string, string];
      if (script.includes('# dsh-ssh-spawn-wrapper v1')) {
        this.runSpawn(channel, script, id, root);
        return channel.process();
      }
      if (script.includes('# dsh-ssh-terminal-wrapper v1')) {
        if (!opts.pty) throw new Error('fake: terminal wrapper requires pty');
        this.lastTerminalPty = opts.pty;
        this.runTerminal(channel, id, root);
        return channel.process();
      }
      return this.simple(channel, 127, '', 'fake: unrecognized bash -c script\n');
    }
    if (command.startsWith('# dsh-ssh-terminal-setup v1')) {
      return this.simple(channel, this.runTerminalSetup(command), '', '');
    }
    if (command.startsWith('test -x ')) {
      const [path] = parseTokens(command.slice('test -x '.length));
      return this.simple(channel, this.programs.has(path!) ? 0 : 1, '', '');
    }
    if (command.startsWith('command -v -- ')) {
      const [name] = parseTokens(command.slice('command -v -- '.length));
      const pathEnv = opts.env?.PATH ?? this.loginEnv.PATH;
      const found = (pathEnv ?? '')
        .split(':')
        .filter(Boolean)
        .map((dir) => `${dir}/${name}`)
        .find((p) => this.programs.has(p) || this.terminalPrograms.has(p));
      return this.simple(channel, found ? 0 : 1, found ? `${found}\n` : '', '');
    }
    if (command.startsWith('cat -- ')) {
      const [path] = parseTokens(command.slice('cat -- '.length));
      const content = this.files.get(path!);
      return content === undefined
        ? this.simple(channel, 1, '', `cat: ${path}: No such file or directory\n`)
        : this.simple(channel, 0, decoder.decode(content), '');
    }
    if (/^kill -[A-Z0-9]+ /.test(command)) {
      return this.simple(channel, this.runKill(command), '', '');
    }
    if (command.startsWith('rm -rf -- ') || command.startsWith('rm -f -- ')) {
      const recursive = command.startsWith('rm -rf');
      const paths = parseTokens(command.slice(command.indexOf('-- ') + 3));
      for (const path of paths) {
        if (recursive) {
          for (const key of [...this.files.keys()]) {
            if (key === path || key.startsWith(`${path}/`)) this.files.delete(key);
          }
          for (const dir of [...this.dirs]) {
            if (dir !== '/' && (dir === path || dir.startsWith(`${path}/`))) this.dirs.delete(dir);
          }
        } else {
          this.files.delete(path);
        }
      }
      return this.simple(channel, 0, '', '');
    }
    if (command.startsWith('ps -o tpgid=,stat= -t ')) {
      const [tty] = parseTokens(command.slice('ps -o tpgid=,stat= -t '.length));
      const proc = [...this.procs.values()].find((p) => p.kind === 'terminal' && p.tty === tty && !p.dead && p.alive);
      if (!proc) return this.simple(channel, 1, '', '');
      return this.simple(channel, 0, ` ${proc.pgid} ${proc.inputWaiting ? 'S' : 'R'}\n`, '');
    }
    if (command.startsWith('ps -eo sid=,pgid=,stat=')) {
      let out = '';
      for (const proc of this.procs.values()) {
        if (proc.dead || !proc.alive) continue;
        out += ` ${proc.pgid} ${proc.pgid} ${proc.inputWaiting ? 'S' : 'R'}\n`;
      }
      return this.simple(channel, 0, out, '');
    }
    return this.simple(channel, 127, '', `sh: fake transport does not recognize this command\n`);
  }

  /** A channel that prints its payload and exits immediately. */
  private simple(channel: FakeChannel, code: number, stdout: string, stderr: string): ExecProcess {
    if (stdout) channel.outQueue.push(encoder.encode(stdout));
    if (stderr) channel.errQueue.push(encoder.encode(stderr));
    queueMicrotask(() => channel.forceClose(code));
    return channel.process();
  }

  private runKill(command: string): number {
    const match = /^kill -([A-Z0-9]+) (.*)$/.exec(command);
    if (!match) return 1;
    const [, sig, rest] = match as [string, string, string];
    const pgids = rest.split(/\s+/).map((t) => Number(t.replace(/^-/, '')));
    let delivered = false;
    for (const pgid of pgids) {
      const proc = this.procs.get(pgid);
      if (!proc || proc.dead || !this.groupAlive(pgid)) continue;
      if (sig === '0') {
        delivered = true;
        continue;
      }
      delivered = true;
      this.deliveredSignals.push({ pgid, signal: `SIG${sig}` });
      if (sig === 'KILL') {
        proc.termCtl.abort();
        proc.killCtl.abort();
        proc.finish('signal:SIGKILL', null, 'KILL', true);
      } else if (sig === 'TERM') {
        proc.termCtl.abort();
        if (!proc.trapTerm) {
          proc.killCtl.abort();
          proc.finish('signal:SIGTERM', null, 'TERM', true);
        }
      } else {
        proc.onSignal?.(`SIG${sig}`);
      }
    }
    if (sig === '0') {
      return pgids.some((pgid) => this.groupAlive(pgid)) ? 0 : 1;
    }
    return delivered ? 0 : 1;
  }

  /** Parse the fixed terminal setup script shape (see wrapper.ts). */
  private runTerminalSetup(script: string): number {
    const dirMatch = /^dsh_dir=('(?:[^']|'\\'')*')$/m.exec(script);
    if (!dirMatch) return 1;
    const [dir] = parseTokens(dirMatch[1]!);
    this.mkdirp(dir!);
    const writeRe = /^printf '%s' ('(?:[^']|'\\'')*') \| base64 -d > "\$dsh_dir\/(\w+)" \|\| exit 125$/gm;
    let m;
    while ((m = writeRe.exec(script)) !== null) {
      const [b64] = parseTokens(m[1]!);
      this.files.set(`${dir}/${m[2]}`, Buffer.from(b64!, 'base64'));
    }
    return 0;
  }

  // ------------------------------------------------------ wrapper simulation

  private registerProc(kind: FakeProc['kind'], finish: FakeProc['finish']): FakeProc {
    const pgid = this.nextPgid++;
    const proc: FakeProc = {
      pgid,
      kind,
      alive: true,
      dead: false,
      members: [],
      inputWaiting: false,
      termCtl: new AbortController(),
      killCtl: new AbortController(),
      trapTerm: false,
      finish,
    };
    this.procs.set(pgid, proc);
    return proc;
  }

  private runSpawn(channel: FakeChannel, _script: string, id: string, root: string): void {
    void (async () => {
      const dir = `${root}/processes/${id}`;
      const fail = (message: string): void => {
        const b64 = Buffer.from(message, 'utf8').toString('base64');
        channel.outQueue.push(encoder.encode(`!DSHSSH FAIL ${b64}\n`));
        channel.forceClose(125);
      };
      this.mkdirp(dir);
      // ---- header ----
      const reader = new StdinReader(channel.stdinQueue);
      const header: string[] = [];
      for (;;) {
        const line = await reader.nextLine();
        if (line === undefined) return fail('truncated header');
        if (line === 'END') break;
        header.push(line);
      }
      const [magic, argvB64, envB64, cwdB64, stdinMode, outSpill, errSpill] = header as [
        string, string, string, string, string, string, string,
      ];
      if (magic !== 'DSHSSH1') return fail('bad header magic');
      const argv = Buffer.from(argvB64, 'base64').toString('utf8').split('\0').filter((s) => s.length > 0);
      const env: Record<string, string> = {};
      for (const entry of Buffer.from(envB64, 'base64').toString('utf8').split('\0')) {
        if (!entry) continue;
        const eq = entry.indexOf('=');
        env[entry.slice(0, eq)] = entry.slice(eq + 1);
      }
      const cwd = Buffer.from(cwdB64, 'base64').toString('utf8');
      if (argv.length === 0) return fail('empty argv');
      if (!this.dirs.has(cwd)) return fail(`cannot chdir: ${cwd}`);
      const outSpillMax = outSpill === '-' ? undefined : Number(outSpill);
      const errSpillMax = errSpill === '-' ? undefined : Number(errSpill);
      if (outSpillMax !== undefined) this.files.set(`${dir}/stdout.spill`, new Uint8Array(0));
      if (errSpillMax !== undefined) this.files.set(`${dir}/stderr.spill`, new Uint8Array(0));

      // ---- process registration + START ----
      let procRef!: FakeProc;
      const proc = this.registerProc('spawn', (status, code, signal, force = false) => {
        procRef.alive = false;
        if (force) {
          procRef.dead = true;
          for (const m of procRef.members) m.pending = false;
        }
        this.files.set(`${dir}/status`, encoder.encode(`${status}\n`));
        channel.outQueue.push(encoder.encode(`!DSHSSH END ${status}\n`));
        channel.forceClose(code, signal);
      });
      procRef = proc;
      channel.onKill = () => {
        if (proc.alive) proc.finish('signal:SIGKILL', null, 'KILL', true);
      };
      this.files.set(`${dir}/pgid`, encoder.encode(`${proc.pgid}\n`));
      channel.outQueue.push(encoder.encode(`!DSHSSH START ${proc.pgid}\n`));

      const frameOut = (chunk: Uint8Array | string): void => {
        const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
        channel.outQueue.push(encoder.encode(`${Buffer.from(bytes).toString('base64')}\n`));
      };
      const frameErr = (chunk: Uint8Array | string): void => {
        const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
        channel.errQueue.push(encoder.encode(`${Buffer.from(bytes).toString('base64')}\n`));
      };
      const spill = (path: string, max: number | undefined, chunk: Uint8Array | string): void => {
        if (max === undefined) return;
        const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
        const existing = this.files.get(path) ?? new Uint8Array(0);
        const room = Math.max(0, max - existing.length);
        const merged = new Uint8Array(existing.length + Math.min(room, bytes.length));
        merged.set(existing);
        merged.set(bytes.subarray(0, room), existing.length);
        this.files.set(path, merged);
      };

      const program = this.resolveProgram(argv[0]!, env.PATH);
      if (!program) {
        frameErr(`env: '${argv[0]}': No such file or directory\n`);
        proc.finish('exit:127', 127);
        return;
      }

      const stdin = stdinMode === 'ignore' ? (async function* () {})() : reader.rest();
      let result: number | void;
      try {
        result = await program({
          argv,
          env,
          cwd,
          pgid: proc.pgid,
          stdin,
          pushStdout: (chunk) => {
            frameOut(chunk);
            spill(`${dir}/stdout.spill`, outSpillMax, chunk);
          },
          pushStderr: (chunk) => {
            frameErr(chunk);
            spill(`${dir}/stderr.spill`, errSpillMax, chunk);
          },
          term: proc.termCtl.signal,
          kill: proc.killCtl.signal,
          get trapTerm() {
            return proc.trapTerm;
          },
          set trapTerm(value: boolean) {
            proc.trapTerm = value;
          },
          addGroupMember: (p) => {
            const member = { promise: p, pending: true };
            void p.finally(() => {
              member.pending = false;
            });
            proc.members.push(member);
          },
        });
      } catch {
        result = 1;
      }
      if (proc.dead) return; // killed while running; finish() already ran
      proc.alive = false;
      const code = typeof result === 'number' ? result : 0;
      // Natural exit: the status/END publish, but registered descendants keep
      // the process group observable (kill -0 stays true) until they settle.
      proc.finish(`exit:${code}`, code);
    })().catch((error) => {
      // Simulation bug surface: close the channel without frames.
      channel.forceClose(1);
      throw error;
    });
  }

  private runTerminal(channel: FakeChannel, id: string, root: string): void {
    void (async () => {
      const dir = `${root}/terminals/${id}`;
      const argvRaw = this.files.get(`${dir}/argv`);
      const envRaw = this.files.get(`${dir}/environment`);
      const cwdRaw = this.files.get(`${dir}/cwd`);
      const markerRaw = this.files.get(`${dir}/marker`);
      if (!argvRaw || !envRaw || !cwdRaw || !markerRaw) {
        channel.forceClose(125);
        return;
      }
      for (const name of ['argv', 'environment', 'cwd', 'marker']) this.files.delete(`${dir}/${name}`);
      const argv = decoder.decode(argvRaw).split('\0').filter((s) => s.length > 0);
      const env: Record<string, string> = {};
      for (const entry of decoder.decode(envRaw).split('\0')) {
        if (!entry) continue;
        const eq = entry.indexOf('=');
        env[entry.slice(0, eq)] = entry.slice(eq + 1);
      }
      const cwd = decoder.decode(cwdRaw);
      const marker = decoder.decode(markerRaw);

      let procRef!: FakeProc;
      const proc = this.registerProc('terminal', (_status, code, signal) => {
        procRef.alive = false;
        procRef.dead = true;
        channel.forceClose(code, signal);
      });
      procRef = proc;
      proc.tty = `pts/${this.nextTty++}`;
      channel.onKill = () => {
        if (proc.alive) proc.finish('signal:SIGKILL', null, 'KILL');
      };
      this.files.set(`${dir}/pid`, encoder.encode(`${proc.pgid}\n`));
      this.files.set(`${dir}/tty`, encoder.encode(`${proc.tty}\n`));
      channel.outQueue.push(encoder.encode(marker));

      const program = this.terminalPrograms.get(argv[0]!) ?? this.resolveTerminalViaPath(argv[0]!, env.PATH);
      if (!program) {
        channel.outQueue.push(encoder.encode(`env: '${argv[0]}': No such file or directory\r\n`));
        proc.finish('exit:127', 127);
        return;
      }
      let result: number | void;
      const io: FakeTerminalIo = {
        argv,
        env,
        cwd,
        input: channel.stdinQueue,
        write: (chunk) => {
          channel.outQueue.push(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
        },
        term: proc.termCtl.signal,
        kill: proc.killCtl.signal,
        get trapTerm() {
          return proc.trapTerm;
        },
        set trapTerm(value: boolean) {
          proc.trapTerm = value;
        },
        setInputWaiting: (waiting) => {
          proc.inputWaiting = waiting;
        },
        get onSignal() {
          return proc.onSignal;
        },
        set onSignal(handler) {
          proc.onSignal = handler;
        },
      };
      try {
        result = await program(io);
      } catch {
        result = 1;
      }
      if (proc.dead) return;
      const code = typeof result === 'number' ? result : 0;
      proc.finish(`exit:${code}`, code);
    })().catch(() => channel.forceClose(1));
  }

  private resolveTerminalViaPath(argv0: string, envPath: string | undefined): FakeTerminalProgram | undefined {
    if (argv0.startsWith('/')) return this.terminalPrograms.get(argv0);
    for (const dir of (envPath ?? this.loginEnv.PATH ?? '').split(':').filter(Boolean)) {
      const program = this.terminalPrograms.get(`${dir}/${argv0}`);
      if (program) return program;
    }
    return undefined;
  }
}
