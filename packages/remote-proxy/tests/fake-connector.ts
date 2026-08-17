/**
 * COPIED from `packages/remote-client/tests/fake-connector.ts` (test-private;
 * import redirected to the published `@dsh-remote/client`).
 *
 * In-memory {@link TargetConnector} for remote-client tests: `connect()` hands
 * out a {@link FakeTransport} whose `exec(backendCommand)` spawns a
 * {@link FakeBackendBroker} channel; any other command exits 127 so tests
 * notice unexpected exec traffic. No cordis, no SSH, no network.
 */
import {
  TransportError,
  type ExecOptions,
  type ExecProcess,
  type RemoteTransport,
  type SftpLike,
} from '@dsh-remote/remote';
import type { TargetConnector } from '@dsh-remote/client';
import type { FakeBackendBroker } from './fake-backend.js';
import { BytePipe } from './byte-pipe.js';

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

export class FakeTransport implements RemoteTransport {
  /** Every command line passed to exec, in order. */
  readonly execLog: string[] = [];

  constructor(
    private readonly broker: FakeBackendBroker,
    private readonly backendCommand: string,
  ) {}

  exec(command: string, _opts?: ExecOptions): Promise<ExecProcess> {
    this.execLog.push(command);
    if (command === this.backendCommand) return Promise.resolve(this.broker.spawn());
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

export class FakeTargetConnector implements TargetConnector {
  /** How many times `connect()` was called (initial connect + reconnects). */
  connectCalls = 0;
  backendCommand = 'dsh-remote-backend serve';
  private readonly entries = new Map<
    string,
    { broker: FakeBackendBroker; pairingTokenRef?: string }
  >();

  /** Register a target backed by `broker`. */
  addTarget(id: string, broker: FakeBackendBroker, pairingTokenRef?: string): void {
    if (this.entries.has(id)) throw new Error(`duplicate target: ${id}`);
    this.entries.set(id, {
      broker,
      ...(pairingTokenRef !== undefined ? { pairingTokenRef } : {}),
    });
  }

  brokerOf(id: string): FakeBackendBroker {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`unknown target: ${id}`);
    return entry.broker;
  }

  connect(targetId: string): Promise<RemoteTransport> {
    const entry = this.entries.get(targetId);
    if (!entry) return Promise.reject(new Error(`fake connector: unknown target: ${targetId}`));
    this.connectCalls++;
    return Promise.resolve(new FakeTransport(entry.broker, this.backendCommand));
  }

  pairingTokenRef(targetId: string): string | undefined {
    return this.entries.get(targetId)?.pairingTokenRef;
  }
}
