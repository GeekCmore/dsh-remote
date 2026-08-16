/**
 * `ctx.fs` provider over SSH: the `FileSystem` seam implemented against a live
 * {@link RemoteTransport} using only SFTP primitives plus a small, fixed set
 * of POSIX exec commands — zero installation on the remote host.
 *
 * Exec command inventory (the complete list this provider ever runs; the
 * in-memory test fake simulates exactly these):
 *
 * 1. `realpath -mz -- '<abs>'` — canonical target identity. `-m` tolerates
 *    missing trailing components so resolving a not-yet-created file succeeds
 *    (required for `createIfAbsent` writes); `-z` NUL-terminates the output.
 * 2. The guarded-publish script (see {@link SshFileSystem.execPublish}): a
 *    `dsh_remote_publish` sh function invoked as
 *    `dsh_remote_publish '<create|replace|force>' '<size>' '<mtime>' '<modeOct>' '<tmp>' '<file>'`.
 *    It re-checks the guard (`[ -e ]` for create, `stat -c '%s %Y %a'`
 *    freshness elements for replace, nothing for force) and `mv -f` publishes
 *    the staged temp file — check and publish inside ONE remote critical
 *    section. Exit codes:
 *    0 published, 3 guard "already exists" (→ FS_NOT_OBSERVED), 4 guard
 *    "absent or stale" (→ FS_STALE_VERSION), anything else → FS_IO_ERROR.
 *
 * Mutations are staged as `<name>.dsh-remote-tmp-<rand>` (mode 0600) in the
 * same directory and published with an atomic same-directory rename.
 */
import { posix } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import { FileSystem, FsError, FsTargetKey } from '@dsh-remote/seams';
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsObservation,
  FsPathInfo,
  FsTarget,
  FsVersion,
  FsWriteIntent,
  FsWriteOutcome,
  SandboxExecutionPolicy,
} from '@dsh-remote/seams';
import type { RemoteTransport, SftpAttrs, SftpLike } from '@dsh-remote/remote';
import { versionElementsOf, versionOfAttrs } from './version.js';
import {
  BinaryProbe,
  concatBytes,
  countLiteral,
  hasCrlf,
  normalizeLf,
  replaceLiteral,
  toCrlf,
} from './text.js';
import { KeyedMutex } from './mutex.js';

/** Construction options for {@link SshFileSystem}. */
export interface SshFileSystemOptions {
  /**
   * Returns the live transport, or `undefined` while disconnected. Every
   * operation calls it lazily so reconnects are picked up; `undefined` maps to
   * `FsError(FS_IO_ERROR)` whose `cause` carries the connection semantics.
   * Mutually exclusive with {@link target}; one of the two is required.
   */
  getTransport?(): RemoteTransport | undefined;
  /**
   * Composition-tree wiring: id of the `ctx.remoteHub` target whose transport
   * this provider uses. Unlike `getTransport` this is expressible in a
   * declarative (YAML) plugin config, so a patch entry can mount this provider
   * directly. The hub is resolved lazily per call, so mounting order and
   * reconnects are both safe.
   */
  target?: string;
  /** Base for relative paths in `resolve`/`lstat` when no per-call cwd is given. */
  defaultCwd?: string;
}

/** TTL for the resolve cache — bounds stale canonical identities after remote renames. */
const RESOLVE_CACHE_TTL_MS = 5_000;

/** Single-quote a string for POSIX sh. */
function sq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Extract a `TransportError`-shaped code without an instanceof link to one class. */
function transportCode(e: unknown): string | undefined {
  if (e instanceof Error && e.name === 'TransportError' && 'code' in e) {
    return (e as { code: string }).code;
  }
  return undefined;
}

function isNoSuch(e: unknown): boolean {
  return transportCode(e) === 'NO_SUCH_FILE';
}

/** Map transport failures onto the seam's error taxonomy. */
function mapFsError(e: unknown, what: string): FsError {
  if (e instanceof FsError) return e;
  const code = transportCode(e);
  const message = e instanceof Error ? e.message : String(e);
  switch (code) {
    case 'NO_SUCH_FILE':
      return new FsError(`${what}: no such file (${message})`, 'FS_NOT_FOUND', { cause: e });
    case 'PERMISSION_DENIED':
      return new FsError(`${what}: permission denied (${message})`, 'FS_PERMISSION_DENIED', { cause: e });
    case 'NOT_DIRECTORY':
      return new FsError(`${what}: not a directory (${message})`, 'FS_NOT_DIRECTORY', { cause: e });
    default:
      return new FsError(`${what}: I/O failure (${message})`, 'FS_IO_ERROR', { cause: e });
  }
}

/** Best-effort cancellation: throw `FS_ABORTED` when the signal has fired. */
function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new FsError('operation aborted', 'FS_ABORTED', { cause: signal.reason });
  }
}

function entryType(attrs: SftpAttrs): FsInfo['type'] {
  if (attrs.isFile()) return 'file';
  if (attrs.isDirectory()) return 'directory';
  return 'other';
}

function pathType(attrs: SftpAttrs): FsPathInfo['type'] {
  if (attrs.isSymbolicLink()) return 'symlink';
  if (attrs.isFile()) return 'file';
  if (attrs.isDirectory()) return 'directory';
  return 'other';
}

export class SshFileSystem extends FileSystem {
  private readonly options: SshFileSystemOptions;
  private readonly getTransport: () => RemoteTransport | undefined;
  private readonly mutations = new KeyedMutex();
  private readonly resolveCache = new Map<string, { target: FsTarget; expires: number }>();

  constructor(ctx: Context, options: SshFileSystemOptions) {
    super(ctx);
    this.options = options;
    if (options.getTransport) {
      this.getTransport = options.getTransport;
    } else if (options.target !== undefined) {
      const target = options.target;
      this.getTransport = () => ctx.reflect.get('remoteHub', false)?.get(target);
    } else {
      throw new Error('fs-ssh: either getTransport or target is required');
    }
  }

  /** Bare backend: never confines; `sandboxPolicy` arguments are ignored. */
  override get sandboxMode(): undefined {
    return undefined;
  }

  // ---------------------------------------------------------------- identity

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    checkAborted(opts?.signal);
    const abs = this.toAbsolute(path, opts?.cwd);
    const cached = this.resolveCache.get(abs);
    if (cached && cached.expires > Date.now()) return cached.target;
    const transport = this.transport();
    const { code, stdout, stderr } = await this.execCapture(
      transport,
      `realpath -mz -- ${sq(abs)}`,
      opts?.signal,
    );
    if (code !== 0 || stdout.length === 0) {
      throw new FsError(`realpath failed for ${abs}: ${stderr.trim()}`, 'FS_IO_ERROR');
    }
    // realpath -z NUL-terminates; -m already lexicalized missing components.
    const real = stdout.endsWith('\0') ? stdout.slice(0, -1) : stdout;
    const target: FsTarget = { targetKey: FsTargetKey(real), displayPath: abs };
    this.resolveCache.set(abs, { target, expires: Date.now() + RESOLVE_CACHE_TTL_MS });
    return target;
  }

  override processPath(target: FsTarget): string {
    // The target key IS the remote absolute path for this backend.
    return target.targetKey as string;
  }

  override fileUrl(target: FsTarget): string {
    // RFC 8089: percent-encode each segment, keep the separators.
    const key = target.targetKey as string;
    return 'file://' + key.split('/').map(encodeURIComponent).join('/');
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    const p = parent.targetKey as string;
    const c = child.targetKey as string;
    if (c === p) return true;
    // Boundary-safe prefix: /a/b must not contain /a/bc.
    return c.startsWith(p === '/' ? '/' : p + '/');
  }

  // ------------------------------------------------------------- metadata

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    checkAborted(signal);
    const sftp = await this.sftp();
    let attrs: SftpAttrs;
    try {
      attrs = await sftp.stat(target.targetKey as string);
    } catch (e) {
      if (isNoSuch(e)) {
        this.emitObserved(target, { kind: 'absent' });
        return undefined;
      }
      throw mapFsError(e, `stat ${target.displayPath}`);
    }
    checkAborted(signal);
    const info: FsInfo = {
      version: versionOfAttrs(attrs),
      type: entryType(attrs),
      size: attrs.isFile() ? attrs.size : undefined,
    };
    this.emitObserved(target, { kind: 'present', version: info.version });
    return info;
  }

  override async lstat(
    path: string,
    opts?: { cwd?: string },
    signal?: AbortSignal,
  ): Promise<FsPathInfo | undefined> {
    checkAborted(signal);
    const abs = this.toAbsolute(path, opts?.cwd);
    const sftp = await this.sftp();
    let attrs: SftpAttrs;
    try {
      attrs = await sftp.lstat(abs);
    } catch (e) {
      if (isNoSuch(e)) return undefined;
      throw mapFsError(e, `lstat ${abs}`);
    }
    checkAborted(signal);
    return {
      version: versionOfAttrs(attrs),
      type: pathType(attrs),
      size: attrs.isFile() ? attrs.size : undefined,
    };
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    checkAborted(signal);
    const key = target.targetKey as string;
    const sftp = await this.sftp();
    let dirAttrs: SftpAttrs;
    try {
      dirAttrs = await sftp.stat(key);
    } catch (e) {
      if (isNoSuch(e)) {
        this.emitObserved(target, { kind: 'absent' });
        throw new FsError(`no such directory: ${target.displayPath}`, 'FS_NOT_FOUND', { cause: e });
      }
      throw mapFsError(e, `stat ${target.displayPath}`);
    }
    if (!dirAttrs.isDirectory()) {
      throw new FsError(`not a directory: ${target.displayPath}`, 'FS_NOT_DIRECTORY');
    }
    let entries: Awaited<ReturnType<SftpLike['readdir']>>;
    try {
      entries = await sftp.readdir(key);
    } catch (e) {
      throw mapFsError(e, `readdir ${target.displayPath}`);
    }
    checkAborted(signal);
    this.emitObserved(target, { kind: 'present', version: versionOfAttrs(dirAttrs) });
    // Stable listing: code-unit name order.
    entries = entries.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return entries.map((entry) => {
      // Child keys are derived by string join + normalize, NOT by one realpath
      // per child — a deliberate performance trade-off: for a symlink child the
      // key names the link path, not its final target identity.
      const joined = key === '/' ? `/${entry.name}` : `${key}/${entry.name}`;
      const childKey = posix.normalize(joined);
      return {
        name: entry.name,
        type: entryType(entry.attrs),
        target: { targetKey: FsTargetKey(childKey), displayPath: childKey },
        version: versionOfAttrs(entry.attrs),
        size: entry.attrs.isFile() ? entry.attrs.size : undefined,
      };
    });
  }

  // ------------------------------------------------------------------ reads

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    await this.statForRead(target, signal);
    const bytes = await this.readAll(target.targetKey as string, signal, undefined, target.displayPath);
    if (new BinaryProbe().push(bytes)) {
      throw new FsError(`binary content rejected: ${target.displayPath}`, 'FS_NOT_TEXT');
    }
    checkAborted(signal);
    return new TextDecoder('utf-8').decode(bytes);
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    await this.statForRead(target, signal);
    const sftp = await this.sftp();
    const key = target.targetKey as string;
    const displayPath = target.displayPath;
    return (async function* () {
      const stream = sftp.createReadStream(key);
      // The provider owns cross-chunk UTF-8 decoding: stream:true keeps a
      // multibyte sequence split across chunks intact.
      const decoder = new TextDecoder('utf-8');
      const probe = new BinaryProbe();
      try {
        for await (const chunk of stream) {
          checkAborted(signal);
          if (probe.push(chunk)) {
            throw new FsError(`binary content rejected: ${displayPath}`, 'FS_NOT_TEXT');
          }
          const text = decoder.decode(chunk, { stream: true });
          if (text) yield text;
        }
        const tail = decoder.decode();
        if (tail) yield tail;
      } catch (e) {
        throw mapFsError(e, `read ${displayPath}`);
      } finally {
        stream.close();
      }
    })();
  }

  override async readBytes(
    target: FsTarget,
    signal: AbortSignal | undefined,
    maxBytes: number,
  ): Promise<Uint8Array> {
    const info = await this.statForRead(target, signal);
    // Stat short-circuit: never open a stream for a file known to exceed the cap.
    if (info.size !== undefined && info.size > maxBytes) {
      throw new FsError(
        `file too large: ${target.displayPath} (${info.size} > ${maxBytes} bytes)`,
        'FS_TOO_LARGE',
      );
    }
    // Streaming guard (in case the size lied or grew): cancel at the first
    // chunk that pushes the running total past the cap.
    return this.readAll(target.targetKey as string, signal, maxBytes, target.displayPath);
  }

  // -------------------------------------------------------------- mutations

  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    void sandboxPolicy; // bare backend ignores per-call policy
    // Policy layer may inject a guard; an explicit `expected` always wins.
    const injected = await this.ctx.waterfall('fs/write-intent', target, undefined, () => undefined);
    const guard = expected ?? injected ?? undefined;
    // Serialize per targetKey so observation and publication cannot interleave
    // with another in-process mutation of the same remote file.
    return this.mutations.run(target.targetKey as string, () =>
      this.performWrite(target, content, guard, signal),
    );
  }

  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    void sandboxPolicy;
    const injected = await this.ctx.waterfall('fs/edit-intent', target, undefined, () => undefined);
    const guard = expected ?? injected ?? undefined;
    return this.mutations.run(target.targetKey as string, () =>
      this.performEdit(target, edit, guard, signal),
    );
  }

  // ---------------------------------------------------------- private: write

  private async performWrite(
    target: FsTarget,
    content: string,
    guard: FsWriteIntent | undefined,
    signal: AbortSignal | undefined,
  ): Promise<FsWriteOutcome> {
    checkAborted(signal);
    const transport = this.transport();
    const sftp = await this.sftp();
    const key = target.targetKey as string;

    const beforeAttrs = await this.statOrUndefined(sftp, key, target.displayPath);
    // Cheap local pre-checks; the authoritative check happens remotely at publish.
    if (guard?.kind === 'createIfAbsent' && beforeAttrs) {
      throw new FsError(`target already exists: ${target.displayPath}`, 'FS_NOT_OBSERVED');
    }
    if (guard?.kind === 'replaceIfVersion') {
      if (!beforeAttrs) {
        throw new FsError(`target absent, cannot replace: ${target.displayPath}`, 'FS_STALE_VERSION');
      }
      if (versionOfAttrs(beforeAttrs) !== guard.version) {
        throw new FsError(`stale version for: ${target.displayPath}`, 'FS_STALE_VERSION');
      }
    }

    // Contextual basis: best effort — a binary or unreadable prior file never
    // blocks the write, it just yields `before: null`.
    let before: string | null = null;
    if (beforeAttrs?.isFile()) {
      before = await this.tryReadBasis(sftp, key);
    }

    checkAborted(signal);
    const tmp = this.tempPathFor(key);
    try {
      await this.upload(sftp, tmp, content);
    } catch (e) {
      await this.silentUnlink(sftp, tmp);
      throw mapFsError(e, `stage ${target.displayPath}`);
    }

    // Atomic publication point — no abort check between here and the rename.
    // Unguarded writes also go through execPublish ('force' mode): OpenSSH's
    // sftp-server refuses SSH_FXP_RENAME over an existing destination, so
    // `sftp.rename` alone cannot implement create-or-overwrite semantics.
    try {
      await this.execPublish(transport, guard, beforeAttrs, tmp, key, target.displayPath, signal);
    } catch (e) {
      await this.silentUnlink(sftp, tmp);
      throw e;
    }
    this.invalidateResolveCache(key);

    let afterAttrs: SftpAttrs;
    try {
      afterAttrs = await sftp.stat(key);
    } catch (e) {
      throw mapFsError(e, `post-write stat ${target.displayPath}`);
    }
    return {
      operation: beforeAttrs ? 'update' : 'create',
      version: versionOfAttrs(afterAttrs),
      before,
      after: normalizeLf(content),
    };
  }

  private async performEdit(
    target: FsTarget,
    edit: FsEditRequest,
    guard: { version: FsVersion } | undefined,
    signal: AbortSignal | undefined,
  ): Promise<FsEditOutcome> {
    checkAborted(signal);
    if (edit.oldString.length === 0) {
      throw new FsError('oldString must be non-empty', 'FS_EDIT_NOT_FOUND');
    }
    const transport = this.transport();
    const sftp = await this.sftp();
    const key = target.targetKey as string;

    const attrs = await this.statOrUndefined(sftp, key, target.displayPath);
    if (!attrs) {
      throw new FsError(`no such file: ${target.displayPath}`, 'FS_NOT_FOUND');
    }
    if (!attrs.isFile()) {
      throw new FsError(`not a regular file: ${target.displayPath}`, 'FS_NOT_REGULAR_FILE');
    }
    // The version guard is checked before matching so stale content reports
    // FS_STALE_VERSION rather than a confusing match failure.
    if (guard && versionOfAttrs(attrs) !== guard.version) {
      throw new FsError(`stale version for: ${target.displayPath}`, 'FS_STALE_VERSION');
    }

    const bytes = await this.readAll(key, signal, undefined, target.displayPath);
    if (new BinaryProbe().push(bytes)) {
      throw new FsError(`binary content rejected: ${target.displayPath}`, 'FS_NOT_TEXT');
    }
    const raw = new TextDecoder('utf-8').decode(bytes);
    // In-memory basis is LF; the original line-ending style is restored on write.
    const crlf = hasCrlf(raw);
    const before = normalizeLf(raw);

    const matches = countLiteral(before, edit.oldString);
    if (matches === 0) {
      throw new FsError(`edit target text not found in: ${target.displayPath}`, 'FS_EDIT_NOT_FOUND');
    }
    if (matches > 1 && !edit.replaceAll) {
      throw new FsError(
        `edit target text matches ${matches} times in: ${target.displayPath}`,
        'FS_AMBIGUOUS_EDIT',
      );
    }
    const after = replaceLiteral(before, edit.oldString, edit.newString, edit.replaceAll);
    const wire = crlf ? toCrlf(after) : after;

    checkAborted(signal);
    const tmp = this.tempPathFor(key);
    try {
      await this.upload(sftp, tmp, wire);
    } catch (e) {
      await this.silentUnlink(sftp, tmp);
      throw mapFsError(e, `stage ${target.displayPath}`);
    }
    // Publish through the guarded script with the just-observed freshness
    // elements: any remote change since our read flips exit code 4 → stale.
    try {
      await this.execPublish(
        transport,
        { kind: 'replaceIfVersion', version: versionOfAttrs(attrs) },
        attrs,
        tmp,
        key,
        target.displayPath,
        signal,
      );
    } catch (e) {
      await this.silentUnlink(sftp, tmp);
      throw e;
    }
    this.invalidateResolveCache(key);

    let afterAttrs: SftpAttrs;
    try {
      afterAttrs = await sftp.stat(key);
    } catch (e) {
      throw mapFsError(e, `post-edit stat ${target.displayPath}`);
    }
    return { version: versionOfAttrs(afterAttrs), before, after };
  }

  /**
   * Run the guarded publish (exec inventory #2): the remote shell re-checks
   * the guard and `mv -f`s the staged temp file in one critical section.
   * `guard === undefined` selects the 'force' mode: no re-check, just the
   * atomic `mv -f` — used for unconditional writes because OpenSSH's
   * sftp-server refuses `SSH_FXP_RENAME` over an existing destination
   * (ssh2 exposes no overwrite flag), while `mv -f` within one directory is
   * the same atomic rename(2).
   *
   * Known v1 limitation: between the local pre-check and this script there is
   * a TOCTOU window on the existence/freshness facts; the script shrinks it to
   * the check→mv gap on the remote, and the per-key in-process mutex plus the
   * single shared connection cover same-host writers. Cross-connection races
   * within that gap are accepted for v1.
   */
  private async execPublish(
    transport: RemoteTransport,
    guard: FsWriteIntent | undefined,
    beforeAttrs: SftpAttrs | undefined,
    tmp: string,
    file: string,
    displayPath: string,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const mode = guard === undefined ? 'force' : guard.kind === 'createIfAbsent' ? 'create' : 'replace';
    const elements =
      guard?.kind === 'replaceIfVersion' && beforeAttrs
        ? versionElementsOf(beforeAttrs)
        : { size: '-', mtime: '-', modeOct: '-' };
    const script = [
      'dsh_remote_publish() {',
      '  dsh_mode=$1 dsh_size=$2 dsh_mtime=$3 dsh_bits=$4 dsh_tmp=$5 dsh_file=$6',
      '  if [ "$dsh_mode" = create ]; then',
      '    if [ -e "$dsh_file" ] || [ -L "$dsh_file" ]; then exit 3; fi',
      '  elif [ "$dsh_mode" = replace ]; then',
      '    if [ ! -e "$dsh_file" ] && [ ! -L "$dsh_file" ]; then exit 4; fi',
      "    dsh_v=$(command stat -c '%s %Y %a' -- \"$dsh_file\") || exit 4",
      '    set -- $dsh_v',
      '    if [ "$1" != "$dsh_size" ] || [ "$2" != "$dsh_mtime" ] || [ "$3" != "$dsh_bits" ]; then exit 4; fi',
      '  fi',
      '  mv -f -- "$dsh_tmp" "$dsh_file"',
      '}',
      [
        'dsh_remote_publish',
        sq(mode),
        sq(String(elements.size)),
        sq(String(elements.mtime)),
        sq(String(elements.modeOct)),
        sq(tmp),
        sq(file),
      ].join(' '),
    ].join('\n');
    const { code, stderr } = await this.execCapture(transport, script, signal);
    if (code === 0) return;
    if (code === 3) {
      throw new FsError(`target already exists: ${displayPath}`, 'FS_NOT_OBSERVED');
    }
    if (code === 4) {
      throw new FsError(`target changed underneath the write: ${displayPath}`, 'FS_STALE_VERSION');
    }
    throw new FsError(
      `remote publish failed for ${displayPath} (exit ${String(code)}): ${stderr.trim()}`,
      'FS_IO_ERROR',
    );
  }

  // ---------------------------------------------------------- private: misc

  /** Lazily acquire the transport; disconnected maps to FS_IO_ERROR with connection semantics in `cause`. */
  private transport(): RemoteTransport {
    const transport = this.getTransport();
    if (!transport) {
      throw new FsError('no live SSH connection', 'FS_IO_ERROR', {
        cause: new Error('remote transport unavailable: connection down or not yet established'),
      });
    }
    return transport;
  }

  private async sftp(): Promise<SftpLike> {
    try {
      return await this.transport().sftp();
    } catch (e) {
      throw mapFsError(e, 'acquire sftp');
    }
  }

  /** Normalize a caller path against the base cwd into a display-form absolute path. */
  private toAbsolute(path: string, cwd?: string): string {
    const base = cwd ?? this.options.defaultCwd ?? '/';
    const joined = posix.isAbsolute(path) ? path : `${base === '/' ? '' : base}/${path}`;
    const abs = posix.normalize(joined);
    return abs.length > 1 ? abs.replace(/\/+$/, '') : abs;
  }

  private async statOrUndefined(
    sftp: SftpLike,
    key: string,
    displayPath: string,
  ): Promise<SftpAttrs | undefined> {
    try {
      return await sftp.stat(key);
    } catch (e) {
      if (isNoSuch(e)) return undefined;
      throw mapFsError(e, `stat ${displayPath}`);
    }
  }

  /** Stat + type gate shared by all read paths; emits the fs/observed fact via stat(). */
  private async statForRead(target: FsTarget, signal: AbortSignal | undefined): Promise<FsInfo> {
    const info = await this.stat(target, signal);
    if (!info) {
      throw new FsError(`no such file: ${target.displayPath}`, 'FS_NOT_FOUND');
    }
    if (info.type !== 'file') {
      throw new FsError(`not a regular file: ${target.displayPath}`, 'FS_NOT_REGULAR_FILE');
    }
    return info;
  }

  /** Read a whole file into memory, enforcing `maxBytes` mid-stream when given. */
  private async readAll(
    key: string,
    signal: AbortSignal | undefined,
    maxBytes?: number,
    displayPath?: string,
  ): Promise<Uint8Array> {
    const sftp = await this.sftp();
    const stream = sftp.createReadStream(key);
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for await (const chunk of stream) {
        checkAborted(signal);
        total += chunk.length;
        if (maxBytes !== undefined && total > maxBytes) {
          stream.close();
          throw new FsError(
            `file too large: ${displayPath ?? key} (>${maxBytes} bytes)`,
            'FS_TOO_LARGE',
          );
        }
        chunks.push(chunk);
      }
    } catch (e) {
      if (e instanceof FsError) throw e;
      throw mapFsError(e, `read ${displayPath ?? key}`);
    }
    return concatBytes(chunks);
  }

  /** Best-effort LF-normalized contextual basis; `null` on binary content or any failure. */
  private async tryReadBasis(sftp: SftpLike, key: string): Promise<string | null> {
    try {
      const stream = sftp.createReadStream(key);
      const chunks: Uint8Array[] = [];
      const probe = new BinaryProbe();
      try {
        for await (const chunk of stream) {
          if (probe.push(chunk)) return null; // binary prior file → no basis
          chunks.push(chunk);
        }
      } finally {
        stream.close();
      }
      return normalizeLf(new TextDecoder('utf-8').decode(concatBytes(chunks)));
    } catch {
      return null;
    }
  }

  private tempPathFor(key: string): string {
    const dir = posix.dirname(key);
    const base = posix.basename(key);
    const rand = randomBytes(6).toString('hex');
    return `${dir === '/' ? '' : dir}/${base}.dsh-remote-tmp-${rand}`;
  }

  private async upload(sftp: SftpLike, path: string, content: string): Promise<void> {
    const ws = sftp.createWriteStream(path, 0o600);
    ws.write(new TextEncoder().encode(content));
    await ws.end();
  }

  private async silentUnlink(sftp: SftpLike, path: string): Promise<void> {
    try {
      await sftp.unlink(path);
    } catch {
      // best-effort staging cleanup
    }
  }

  /** Run an exec command to completion, capturing stdout/stderr. */
  private async execCapture(
    transport: RemoteTransport,
    command: string,
    signal: AbortSignal | undefined,
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    let proc;
    try {
      proc = await transport.exec(command, { signal });
    } catch (e) {
      throw mapFsError(e, 'exec');
    }
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

  private emitObserved(target: FsTarget, observation: FsObservation): void {
    this.ctx.emit('fs/observed', target, observation, undefined);
  }

  /** Drop cached resolutions pointing at a key we just mutated. */
  private invalidateResolveCache(key: string): void {
    for (const [input, entry] of this.resolveCache) {
      if ((entry.target.targetKey as string) === key) this.resolveCache.delete(input);
    }
  }
}

export default SshFileSystem;
