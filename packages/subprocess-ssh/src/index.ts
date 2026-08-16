/**
 * `@dsh-remote/subprocess-ssh` — the SSH provider for the dsh subprocess seam
 * (`ctx.subprocess`). The default export is the Cordis service class; the
 * `Context { subprocess: SubprocessRuntime }` augmentation is declared by
 * `@dsh-remote/seams` and intentionally not repeated here.
 */
import { SshSubprocessRuntime } from './runtime.js';

export { SshSubprocessRuntime } from './runtime.js';
export type { SshSubprocessRuntimeOptions } from './runtime.js';
export type { SubprocessHost } from './process.js';
export { SshSubprocessHandle } from './process.js';
export { SshTerminalHandle } from './terminal.js';
export { TailOutputReader, FrameDecoder } from './output.js';
export { RemoteEnvironment, mergeEnvironment } from './environment.js';

export default SshSubprocessRuntime;
