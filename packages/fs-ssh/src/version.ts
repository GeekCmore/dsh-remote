/**
 * Version-token derivation for the SSH filesystem backend.
 *
 * A token is the SHA-256 hex digest of the JSON-encoded freshness elements
 * `{size, mtime, mode}` taken from SFTP attributes, with the permission bits
 * rendered in octal exactly as `stat -c %a` prints them. Keeping the elements
 * in `stat(1)` vocabulary lets the guarded-publish exec script recompute them
 * on the remote side and compare inside one remote critical section.
 *
 * v1 granularity note: SFTP (and `stat -c %Y`) report `mtime` at whole-second
 * precision, so two writes landing within the same second with the same size
 * and mode collapse onto one token. Consumers needing sub-second freshness
 * must wait for a revision-id based v2.
 */
import { createHash } from 'node:crypto';
import { FsVersion } from '@dsh-remote/seams';
import type { FsVersion as FsVersionType } from '@dsh-remote/seams';
import type { SftpAttrs } from '@dsh-remote/remote';

/** Raw freshness elements behind a version token. */
export interface VersionElements {
  /** Byte size, `stat -c %s`. */
  readonly size: number;
  /** Modification time, seconds since epoch, `stat -c %Y`. */
  readonly mtime: number;
  /** Permission bits in octal, `stat -c %a` (e.g. `"644"`). */
  readonly modeOct: string;
}

/** Extract the freshness elements from SFTP attributes. */
export function versionElementsOf(attrs: SftpAttrs): VersionElements {
  return {
    size: attrs.size,
    mtime: attrs.mtime,
    modeOct: (attrs.mode & 0o777).toString(8),
  };
}

/** Hash freshness elements into the opaque {@link FsVersionType} token. */
export function versionTokenOf(elements: VersionElements): FsVersionType {
  const digest = createHash('sha256')
    .update(JSON.stringify([elements.size, elements.mtime, elements.modeOct]))
    .digest('hex');
  return FsVersion(digest);
}

/** Convenience composition of {@link versionElementsOf} and {@link versionTokenOf}. */
export function versionOfAttrs(attrs: SftpAttrs): FsVersionType {
  return versionTokenOf(versionElementsOf(attrs));
}
