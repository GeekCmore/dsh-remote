/**
 * `@dsh-remote/fs-ssh` — the SSH provider for the dsh filesystem seam
 * (`ctx.fs`). The default export is the Cordis service class; the
 * `Context { fs: FileSystem }` augmentation is declared by `@dsh-remote/seams`
 * and intentionally not repeated here.
 */
import { SshFileSystem } from './fs-ssh.js';

export { SshFileSystem } from './fs-ssh.js';
export type { SshFileSystemOptions } from './fs-ssh.js';
export type {
  ExecOptions,
  ExecProcess,
  RemoteTransport,
  SftpAttrs,
  SftpDirEntry,
  SftpLike,
  SftpWriteStream,
} from '@dsh-remote/remote';
export { TransportError } from '@dsh-remote/remote';

export default SshFileSystem;
