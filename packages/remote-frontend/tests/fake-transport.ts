/**
 * Lightweight in-memory fake of the `RemoteTransport`/`SftpLike` contract for
 * remote-frontend tests: a POSIX-style file tree (files and directories) plus
 * an exec simulator that understands exactly what the code under test runs:
 *
 * 1. `realpath -mz -- '<path>'` — needed by `SshFileSystem.resolve`.
 * 2. The `@@`-framed aggregate metrics probe from `buildMetricsProbeCommand`,
 *    answered from a mutable fixture.
 *
 * Any other command exits 127 so tests notice unexpected exec traffic.
 */
import { posix } from 'node:path';
import { TransportError } from '@dsh-remote/remote';
import type {
  ExecOptions,
  ExecProcess,
  RemoteTransport,
  SftpAttrs,
  SftpDirEntry,
  SftpLike,
  SftpWriteStream,
} from '@dsh-remote/remote';

type FakeNode =
  | { kind: 'file'; content: Uint8Array; mode: number; mtime: number }
  | { kind: 'dir'; children: Map<string, FakeNode>; mode: number; mtime: number };

/** Parse a sequence of POSIX single-quoted tokens. */
export function parseSqArgs(input: string): string[] {
  const args: string[] = [];
  let i = 0;
  const s = input.trim();
  while (i < s.length) {
    while (i < s.length && s[i] === ' ') i++;
    if (i >= s.length) break;
    if (s[i] !== "'") throw new Error(`fake parseSqArgs: expected quote at ${i} in ${input}`);
    i++;
    let token = '';
    for (;;) {
      const end = s.indexOf("'", i);
      if (end < 0) throw new Error(`fake parseSqArgs: unterminated quote in ${input}`);
      token += s.slice(i, end);
      i = end + 1;
      if (s[i] === '\\' && s[i + 1] === "'") {
        token += "'";
        i += 2;
        continue;
      }
      break;
    }
    args.push(token);
  }
  return args;
}

/** Mutable fixture backing the simulated metrics probe. */
export interface MetricsFixture {
  loadavg: string;
  memTotalKb: number;
  memAvailableKb: number;
  /** The aggregate `cpu` line of /proc/stat, WITHOUT the leading "cpu  ". */
  cpuFields: string;
  dfTotalKb: number;
  dfAvailKb: number;
  processCount: number;
}

export function defaultFixture(): MetricsFixture {
  return {
    loadavg: '0.10 0.20 0.30 2/145 3214',
    memTotalKb: 16_384_000,
    memAvailableKb: 8_192_000,
    cpuFields: '100 0 100 700 50 0 0 0 0 0',
    dfTotalKb: 1_024_000,
    dfAvailKb: 512_000,
    processCount: 123,
  };
}

export interface FakeTransportOptions {
  /** Read-stream chunk size in bytes (small values exercise chunked copies). */
  readChunkSize?: number;
}

export class FakeTransport implements RemoteTransport, SftpLike {
  private root: FakeNode = { kind: 'dir', children: new Map(), mode: 0o755, mtime: 0 };
  private clock = 1_700_000_000;
  private readonly readChunkSize: number;
  readonly fixture: MetricsFixture = defaultFixture();
  /** Test hook: make every exec fail with CONN_LOST. */
  failExec = false;
  /** Test hook: number of exec calls seen. */
  execCount = 0;
  closed = false;

  constructor(options: FakeTransportOptions = {}) {
    this.readChunkSize = options.readChunkSize ?? 64 * 1024;
  }

  // ------------------------------------------------------------ test helpers

  private tick(): number {
    return ++this.clock;
  }

  mkdir(path: string, mode = 0o755): Promise<void> {
    const parts = posix.normalize(path).split('/').filter(Boolean);
    let node = this.root;
    for (const part of parts) {
      let child = node.children.get(part);
      if (!child) {
        child = { kind: 'dir', children: new Map(), mode, mtime: this.tick() };
        node.children.set(part, child);
      }
      if (child.kind !== 'dir') throw new TransportError(`not a directory: ${path}`, 'NOT_DIRECTORY');
      node = child;
    }
    return Promise.resolve();
  }

  writeFile(path: string, content: string | Uint8Array, mode = 0o644): void {
    const abs = posix.normalize(path);
    const parent = this.lookup(posix.dirname(abs));
    if (!parent || parent.kind !== 'dir') {
      throw new TransportError(`no such directory: ${posix.dirname(abs)}`, 'NO_SUCH_FILE');
    }
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    parent.children.set(posix.basename(abs), {
      kind: 'file',
      content: bytes.slice(),
      mode,
      mtime: this.tick(),
    });
  }

  readFile(path: string): Uint8Array {
    const node = this.lookup(posix.normalize(path));
    if (!node || node.kind !== 'file') throw new TransportError(`no such file: ${path}`, 'NO_SUCH_FILE');
    return node.content.slice();
  }

  exists(path: string): boolean {
    return this.lookup(posix.normalize(path)) !== undefined;
  }

  // ------------------------------------------------------------- internals

  private lookup(path: string): FakeNode | undefined {
    const parts = posix.normalize(path).split('/').filter(Boolean);
    let node: FakeNode = this.root;
    for (const part of parts) {
      if (node.kind !== 'dir') return undefined;
      const child: FakeNode | undefined = node.children.get(part);
      if (!child) return undefined;
      node = child;
    }
    return node;
  }

  private attrsOf(node: FakeNode): SftpAttrs {
    const typeBits = node.kind === 'file' ? 0o100000 : 0o040000;
    return {
      size: node.kind === 'file' ? node.content.length : 4096,
      mode: typeBits | node.mode,
      mtime: node.mtime,
      atime: node.mtime,
      isFile: () => node.kind === 'file',
      isDirectory: () => node.kind === 'dir',
      isSymbolicLink: () => false,
    };
  }

  private assertOpen(): void {
    if (this.closed) throw new TransportError('connection lost', 'CONN_LOST');
  }

  // ----------------------------------------------------------------- SftpLike

  stat(path: string): Promise<SftpAttrs> {
    this.assertOpen();
    const node = this.lookup(path);
    if (!node) return Promise.reject(new TransportError(`no such file: ${path}`, 'NO_SUCH_FILE'));
    return Promise.resolve(this.attrsOf(node));
  }

  lstat(path: string): Promise<SftpAttrs> {
    return this.stat(path);
  }

  readdir(path: string): Promise<SftpDirEntry[]> {
    this.assertOpen();
    const node = this.lookup(path);
    if (!node) return Promise.reject(new TransportError(`no such directory: ${path}`, 'NO_SUCH_FILE'));
    if (node.kind !== 'dir') {
      return Promise.reject(new TransportError(`not a directory: ${path}`, 'NOT_DIRECTORY'));
    }
    return Promise.resolve(
      [...node.children.entries()].map(([name, child]) => ({ name, attrs: this.attrsOf(child) })),
    );
  }

  rename(oldPath: string, newPath: string): Promise<void> {
    this.assertOpen();
    const srcDir = this.lookup(posix.dirname(oldPath));
    const dstDir = this.lookup(posix.dirname(newPath));
    const node = srcDir?.kind === 'dir' ? srcDir.children.get(posix.basename(oldPath)) : undefined;
    if (!node || !dstDir || dstDir.kind !== 'dir') {
      return Promise.reject(new TransportError(`rename failed: ${oldPath}`, 'NO_SUCH_FILE'));
    }
    srcDir!.children.delete(posix.basename(oldPath));
    node.mtime = this.tick();
    dstDir.children.set(posix.basename(newPath), node);
    return Promise.resolve();
  }

  unlink(path: string): Promise<void> {
    this.assertOpen();
    const dir = this.lookup(posix.dirname(path));
    const node = dir?.kind === 'dir' ? dir.children.get(posix.basename(path)) : undefined;
    if (!dir || dir.kind !== 'dir' || !node) {
      return Promise.reject(new TransportError(`no such file: ${path}`, 'NO_SUCH_FILE'));
    }
    dir.children.delete(posix.basename(path));
    return Promise.resolve();
  }

  rmdir(path: string): Promise<void> {
    this.assertOpen();
    const dir = this.lookup(posix.dirname(path));
    const node = dir?.kind === 'dir' ? dir.children.get(posix.basename(path)) : undefined;
    if (!node || node.kind !== 'dir') {
      return Promise.reject(new TransportError(`no such directory: ${path}`, 'NO_SUCH_FILE'));
    }
    if (dir?.kind === 'dir') dir.children.delete(posix.basename(path));
    return Promise.resolve();
  }

  createReadStream(path: string): AsyncIterable<Uint8Array> & { close(): void } {
    this.assertOpen();
    const node = this.lookup(path);
    const chunkSize = this.readChunkSize;
    let closed = false;
    const fail = !node
      ? new TransportError(`no such file: ${path}`, 'NO_SUCH_FILE')
      : node.kind !== 'file'
        ? new TransportError(`not a regular file: ${path}`, 'IO_ERROR')
        : undefined;
    const content = node?.kind === 'file' ? node.content : new Uint8Array(0);
    return {
      close() {
        closed = true;
      },
      [Symbol.asyncIterator]() {
        let offset = 0;
        return {
          next(): Promise<IteratorResult<Uint8Array>> {
            if (fail) return Promise.reject(fail);
            if (closed || offset >= content.length) {
              return Promise.resolve({ done: true, value: undefined });
            }
            const end = Math.min(offset + chunkSize, content.length);
            const chunk = content.slice(offset, end);
            offset = end;
            return Promise.resolve({ done: false, value: chunk });
          },
        };
      },
    };
  }

  createWriteStream(path: string, mode = 0o644): SftpWriteStream {
    this.assertOpen();
    const abs = posix.normalize(path);
    const chunks: Uint8Array[] = [];
    return {
      write(chunk: Uint8Array) {
        chunks.push(chunk.slice());
      },
      end: () => {
        const parent = this.lookup(posix.dirname(abs));
        if (!parent || parent.kind !== 'dir') {
          return Promise.reject(
            new TransportError(`no such directory: ${posix.dirname(abs)}`, 'NO_SUCH_FILE'),
          );
        }
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const content = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          content.set(chunk, offset);
          offset += chunk.length;
        }
        parent.children.set(posix.basename(abs), {
          kind: 'file',
          content,
          mode,
          mtime: this.tick(),
        });
        return Promise.resolve();
      },
    };
  }

  // ---------------------------------------------------------- RemoteTransport

  sftp(): Promise<SftpLike> {
    this.assertOpen();
    return Promise.resolve(this);
  }

  exec(command: string, _opts?: ExecOptions): Promise<ExecProcess> {
    this.assertOpen();
    this.execCount++;
    if (this.failExec) {
      return Promise.reject(new TransportError('connection lost', 'CONN_LOST'));
    }
    let code = 0;
    let stdout = '';
    let stderr = '';
    try {
      if (command.startsWith('realpath -mz -- ')) {
        const [path] = parseSqArgs(command.slice('realpath -mz -- '.length));
        stdout = posix.normalize(path!) + '\0';
      } else if (command.startsWith("{ echo '@@loadavg'")) {
        stdout = this.probeOutput();
      } else {
        code = 127;
        stderr = 'sh: fake transport does not recognize this command\n';
      }
    } catch (e) {
      code = 1;
      stderr = e instanceof Error ? e.message : String(e);
    }
    return Promise.resolve(fakeProcess(stdout, stderr, code));
  }

  /** The simulated aggregate metrics probe, framed exactly like the real one. */
  private probeOutput(): string {
    const f = this.fixture;
    return [
      '@@loadavg',
      f.loadavg,
      '@@mem',
      `MemTotal:       ${f.memTotalKb} kB`,
      `MemAvailable:   ${f.memAvailableKb} kB`,
      '@@cpu',
      `cpu  ${f.cpuFields}`,
      '@@df',
      'Filesystem     1024-blocks    Used Available Capacity Mounted on',
      `/dev/sda1       ${f.dfTotalKb}  ${f.dfTotalKb - f.dfAvailKb}    ${f.dfAvailKb}   50% /`,
      '@@ps',
      ` ${f.processCount}`,
      '',
    ].join('\n');
  }

  probeLoginEnv(vars: string[]): Promise<Record<string, string>> {
    const env: Record<string, string> = {};
    for (const v of vars) env[v] = v === 'HOME' ? '/home/fake' : '';
    return Promise.resolve(env);
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

function fakeProcess(stdout: string, stderr: string, code: number): ExecProcess {
  const encode = new TextEncoder();
  return {
    stdout: (async function* () {
      if (stdout) yield encode.encode(stdout);
    })(),
    stderr: (async function* () {
      if (stderr) yield encode.encode(stderr);
    })(),
    write() {},
    endStdin() {},
    done: Promise.resolve({ code }),
    kill: () => Promise.resolve(),
  };
}
