/**
 * In-memory fake of the `RemoteTransport`/`SftpLike` contract for fs-ssh tests:
 * a POSIX-style file tree (files / directories / symlinks) plus an exec
 * simulator that understands exactly the provider's exec command inventory:
 *
 * 1. `realpath -mz -- '<path>'`
 * 2. the `dsh_remote_publish` guarded-publish script (create/replace/force modes)
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
  | { kind: 'dir'; children: Map<string, FakeNode>; mode: number; mtime: number }
  | { kind: 'symlink'; target: string; mode: number; mtime: number };

/** Parse a sequence of POSIX single-quoted tokens (`'a' 'b'\''c'`). */
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

export interface FakeTransportOptions {
  /** Read-stream chunk size in bytes (small values exercise cross-chunk decoding). */
  readChunkSize?: number;
  /** Called with every exec command before it is handled (race injection). */
  onExec?: (command: string) => void;
}

export class FakeTransport implements RemoteTransport, SftpLike {
  private root: FakeNode = { kind: 'dir', children: new Map(), mode: 0o755, mtime: 0 };
  private clock = 1_700_000_000;
  private readonly readChunkSize: number;
  private readonly onExec?: (command: string) => void;
  /** Test hook: lie about a file's stat size (exercises the mid-stream size guard). */
  readonly sizeOverrides = new Map<string, number>();
  /** Test hook: number of exec calls seen. */
  execCount = 0;
  closed = false;

  constructor(options: FakeTransportOptions = {}) {
    this.readChunkSize = options.readChunkSize ?? 64 * 1024;
    this.onExec = options.onExec;
  }

  // ------------------------------------------------------------ test helpers

  private tick(): number {
    return ++this.clock;
  }

  mkdir(path: string, mode = 0o755): Promise<void> {
    const abs = posix.normalize(path);
    const parts = abs.split('/').filter(Boolean);
    let node = this.root;
    for (const part of parts) {
      let child = node.kind === 'dir' ? node.children.get(part) : undefined;
      if (!child) {
        child = { kind: 'dir', children: new Map(), mode, mtime: this.tick() };
        if (node.kind !== 'dir') throw new TransportError(`not a directory: ${abs}`, 'NOT_DIRECTORY');
        node.children.set(part, child);
      }
      node = child;
    }
    return Promise.resolve();
  }

  writeFile(path: string, content: string | Uint8Array, mode = 0o644): void {
    const abs = posix.normalize(path);
    const parent = this.lookupNoFollow(posix.dirname(abs));
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

  symlink(target: string, path: string): void {
    const abs = posix.normalize(path);
    const parent = this.lookupNoFollow(posix.dirname(abs));
    if (!parent || parent.kind !== 'dir') {
      throw new TransportError(`no such directory: ${posix.dirname(abs)}`, 'NO_SUCH_FILE');
    }
    parent.children.set(posix.basename(abs), {
      kind: 'symlink',
      target,
      mode: 0o777,
      mtime: this.tick(),
    });
  }

  readFile(path: string): Uint8Array {
    const node = this.lookup(this.canon(path));
    if (!node || node.kind !== 'file') throw new TransportError(`no such file: ${path}`, 'NO_SUCH_FILE');
    return node.content.slice();
  }

  exists(path: string): boolean {
    return this.lookup(this.canon(path)) !== undefined;
  }

  // ------------------------------------------------------------- path lookup

  /** Walk exact components with no symlink resolution; undefined when missing. */
  private lookupNoFollow(path: string): FakeNode | undefined {
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

  /** Canonicalize like `realpath -m`: resolve existing symlinks, pass missing tails through. */
  private canon(path: string): string {
    const parts = posix.normalize(path).split('/').filter(Boolean);
    return '/' + this.resolveParts(parts, 0).join('/');
  }

  private resolveParts(parts: string[], depth: number): string[] {
    if (depth > 40) throw new TransportError('too many levels of symbolic links', 'IO_ERROR');
    const result: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      result.push(parts[i]!);
      const node = this.lookupNoFollow('/' + result.join('/'));
      if (node && node.kind === 'symlink') {
        const prefix = node.target.startsWith('/')
          ? node.target.split('/').filter(Boolean)
          : posix
              .normalize('/' + result.slice(0, -1).join('/') + '/' + node.target)
              .split('/')
              .filter(Boolean);
        return this.resolveParts([...prefix, ...parts.slice(i + 1)], depth + 1);
      }
    }
    return result;
  }

  /** Follow a canonical path; undefined when absent. */
  private lookup(canonical: string): FakeNode | undefined {
    return this.lookupNoFollow(canonical);
  }

  private attrsOf(node: FakeNode, canonicalPath?: string): SftpAttrs {
    const typeBits = node.kind === 'file' ? 0o100000 : node.kind === 'dir' ? 0o040000 : 0o120000;
    const natural =
      node.kind === 'file' ? node.content.length : node.kind === 'dir' ? 4096 : node.target.length;
    const size = (canonicalPath && this.sizeOverrides.get(canonicalPath)) ?? natural;
    return {
      size,
      mode: typeBits | node.mode,
      mtime: node.mtime,
      atime: node.mtime,
      isFile: () => node.kind === 'file',
      isDirectory: () => node.kind === 'dir',
      isSymbolicLink: () => node.kind === 'symlink',
    };
  }

  private assertOpen(): void {
    if (this.closed) throw new TransportError('connection lost', 'CONN_LOST');
  }

  // ----------------------------------------------------------------- SftpLike

  stat(path: string): Promise<SftpAttrs> {
    this.assertOpen();
    const canonical = this.canon(path);
    const node = this.lookup(canonical);
    if (!node) return Promise.reject(new TransportError(`no such file: ${path}`, 'NO_SUCH_FILE'));
    return Promise.resolve(this.attrsOf(node, canonical));
  }

  lstat(path: string): Promise<SftpAttrs> {
    this.assertOpen();
    const abs = posix.normalize(path);
    const dir = this.canon(posix.dirname(abs));
    const full = dir === '/' ? `/${posix.basename(abs)}` : `${dir}/${posix.basename(abs)}`;
    const node = this.lookupNoFollow(full);
    if (!node) return Promise.reject(new TransportError(`no such file: ${path}`, 'NO_SUCH_FILE'));
    return Promise.resolve(this.attrsOf(node, full));
  }

  readdir(path: string): Promise<SftpDirEntry[]> {
    this.assertOpen();
    const canonical = this.canon(path);
    const node = this.lookup(canonical);
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
    const srcAbs = posix.normalize(oldPath);
    const srcDir = this.lookup(this.canon(posix.dirname(srcAbs)));
    const srcBase = posix.basename(srcAbs);
    if (!srcDir || srcDir.kind !== 'dir' || !srcDir.children.has(srcBase)) {
      return Promise.reject(new TransportError(`no such file: ${oldPath}`, 'NO_SUCH_FILE'));
    }
    const dstAbs = posix.normalize(newPath);
    const dstDir = this.lookup(this.canon(posix.dirname(dstAbs)));
    if (!dstDir || dstDir.kind !== 'dir') {
      return Promise.reject(new TransportError(`no such directory: ${posix.dirname(dstAbs)}`, 'NO_SUCH_FILE'));
    }
    // OpenSSH sftp-server semantics: SSH_FXP_RENAME without the posix-rename
    // extension fails when the destination already exists.
    if (dstDir.children.has(posix.basename(dstAbs))) {
      return Promise.reject(new TransportError(`rename ${oldPath} ${newPath}: failure`, 'IO_ERROR'));
    }
    const node = srcDir.children.get(srcBase)!;
    srcDir.children.delete(srcBase);
    node.mtime = this.tick();
    dstDir.children.set(posix.basename(dstAbs), node);
    return Promise.resolve();
  }

  unlink(path: string): Promise<void> {
    this.assertOpen();
    const abs = posix.normalize(path);
    const dir = this.lookup(this.canon(posix.dirname(abs)));
    const node = dir?.kind === 'dir' ? dir.children.get(posix.basename(abs)) : undefined;
    if (!dir || dir.kind !== 'dir' || !node) {
      return Promise.reject(new TransportError(`no such file: ${path}`, 'NO_SUCH_FILE'));
    }
    if (node.kind === 'dir') {
      return Promise.reject(new TransportError(`is a directory: ${path}`, 'IO_ERROR'));
    }
    dir.children.delete(posix.basename(abs));
    return Promise.resolve();
  }

  rmdir(path: string): Promise<void> {
    this.assertOpen();
    const abs = posix.normalize(path);
    const dir = this.lookup(this.canon(posix.dirname(abs)));
    const node = dir?.kind === 'dir' ? dir.children.get(posix.basename(abs)) : undefined;
    if (!node || node.kind !== 'dir') {
      return Promise.reject(new TransportError(`no such directory: ${path}`, 'NO_SUCH_FILE'));
    }
    if (dir?.kind === 'dir') dir.children.delete(posix.basename(abs));
    return Promise.resolve();
  }

  createReadStream(path: string): AsyncIterable<Uint8Array> & { close(): void } {
    this.assertOpen();
    const canonical = this.canon(path);
    const node = this.lookup(canonical);
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
            if (closed || offset >= content.length) return Promise.resolve({ done: true, value: undefined });
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
        const parent = this.lookup(this.canon(posix.dirname(abs)));
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
    this.onExec?.(command);
    let code = 0;
    let stdout = '';
    let stderr = '';
    try {
      if (command.startsWith('realpath -mz -- ')) {
        const [path] = parseSqArgs(command.slice('realpath -mz -- '.length));
        stdout = this.canon(path!) + '\0';
      } else if (command.startsWith('dsh_remote_publish() {')) {
        const lines = command.trim().split('\n');
        const invoke = lines[lines.length - 1]!;
        const args = parseSqArgs(invoke.slice('dsh_remote_publish '.length));
        code = this.publish(args);
      } else {
        code = 127;
        stderr = `sh: fake transport does not recognize this command\n`;
      }
    } catch (e) {
      code = 1;
      stderr = e instanceof Error ? e.message : String(e);
    }
    return Promise.resolve(fakeProcess(stdout, stderr, code));
  }

  /** The dsh_remote_publish sh function, simulated on the in-memory tree. */
  private publish(args: string[]): number {
    const [mode, size, mtime, bits, tmp, file] = args as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const canonical = this.canon(file);
    const existing = this.lookup(canonical);
    if (mode === 'create') {
      if (existing) return 3;
    } else if (mode === 'replace') {
      if (!existing) return 4;
      const attrs = this.attrsOf(existing, canonical);
      if (
        String(attrs.size) !== size ||
        String(attrs.mtime) !== mtime ||
        (attrs.mode & 0o777).toString(8) !== bits
      ) {
        return 4;
      }
    }
    // 'force': no guard re-check, straight to mv -f.
    try {
      // mv -f tmp file
      const srcAbs = posix.normalize(tmp);
      const srcDir = this.lookupNoFollow(posix.dirname(srcAbs));
      if (!srcDir || srcDir.kind !== 'dir') return 1;
      const node = srcDir.children.get(posix.basename(srcAbs));
      if (!node) return 1;
      srcDir.children.delete(posix.basename(srcAbs));
      node.mtime = this.tick();
      const dstDir = this.lookupNoFollow(posix.dirname(canonical));
      if (!dstDir || dstDir.kind !== 'dir') return 1;
      dstDir.children.set(posix.basename(canonical), node);
      return 0;
    } catch {
      return 1;
    }
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
