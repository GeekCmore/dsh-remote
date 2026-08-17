/**
 * The exec-transport half shared by {@link FakeTargetConnector},
 * {@link FakeRemoteHub} and {@link RigRemoteHub} (previously three near-identical
 * `FakeTransport`/`RigTransport` classes): `exec(backendCommand)` spawns one
 * backend channel via the given `spawn` callback; any other command exits 127
 * so tests notice unexpected exec traffic. No SSH, no network.
 */
import {
  TransportError,
  type ExecOptions,
  type ExecProcess,
  type RemoteTransport,
  type SftpLike,
} from '@dsh-remote/remote';
import { BytePipe } from '@dsh-remote/test-utils';

/** An exec process for a command the fake does not implement: exits 127. */
function deadProcess(command: string): ExecProcess {
  const stdout = new BytePipe();
  stdout.end();
  const stderr = new BytePipe();
  stderr.push(new TextEncoder().encode(`fake: command not found: ${command}\n`));
  stderr.end();
  return {
    stdout,
    stderr,
    write: () => {},
    endStdin: () => {},
    done: Promise.resolve({ code: 127 }),
    kill: async () => {},
  };
}

export class FakeBackendTransport implements RemoteTransport {
  /** Every command line passed to exec, in order. */
  readonly execLog: string[] = [];

  constructor(
    private readonly spawn: () => ExecProcess,
    private readonly backendCommand: string,
  ) {}

  exec(command: string, _opts?: ExecOptions): Promise<ExecProcess> {
    this.execLog.push(command);
    if (command === this.backendCommand) return Promise.resolve(this.spawn());
    return Promise.resolve(deadProcess(command));
  }

  sftp(): Promise<SftpLike> {
    return Promise.reject(new TransportError('fake: no sftp', 'IO_ERROR'));
  }

  probeLoginEnv(_vars: string[]): Promise<Record<string, string>> {
    return Promise.resolve({});
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
