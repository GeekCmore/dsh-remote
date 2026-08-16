/**
 * In-memory fake of `ctx.remoteHub` for remote-daemon tests: `connect()` hands
 * out a {@link FakeTransport} whose `exec(backendCommand)` spawns a
 * {@link FakeBackendBroker} channel; any other command exits 127 so tests
 * notice unexpected exec traffic. No SSH, no network.
 */
import { Context } from '@deepseek-ai/cordis';
import {
  RemoteHub,
  TransportError,
  type ConnectionStatus,
  type ExecOptions,
  type ExecProcess,
  type RemoteTarget,
  type RemoteTargetInfo,
  type RemoteTransport,
  type SftpLike,
} from '@dsh-remote/remote';
import type { FakeBackendBroker } from './fake-backend.js';
import { BytePipe } from './byte-pipe.js';

interface FakeTargetEntry {
  config: RemoteTarget;
  broker: FakeBackendBroker;
  connected: boolean;
}

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

export class FakeRemoteHub extends RemoteHub {
  /** How many times `connect()` was called (initial connect + reconnects). */
  connectCalls = 0;
  backendCommand = 'dsh-remote-backend serve';
  private readonly entries = new Map<string, FakeTargetEntry>();

  constructor(ctx: Context) {
    super(ctx);
  }

  /** Register a target backed by `broker`; returns the target id. */
  addBackendTarget(id: string, broker: FakeBackendBroker, pairingTokenRef?: string): string {
    const targetId = this.addTarget({
      id,
      ssh: { host: 'fake.test', username: 'dsh', auth: { type: 'password', password: 'x' } },
      ...(pairingTokenRef !== undefined ? { pairingTokenRef } : {}),
    });
    this.setBroker(targetId, broker);
    return targetId;
  }

  override addTarget(config: RemoteTarget): string {
    const id = config.id ?? `t-${this.entries.size + 1}`;
    if (this.entries.has(id)) throw new Error(`duplicate remote target id: ${id}`);
    // The broker is attached by addBackendTarget right after; fill in lazily.
    this.entries.set(id, {
      config: { ...config, id },
      broker: undefined as unknown as FakeBackendBroker,
      connected: false,
    });
    return id;
  }

  /** Attach the broker for a target registered via plain addTarget. */
  setBroker(id: string, broker: FakeBackendBroker): void {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`unknown target: ${id}`);
    entry.broker = broker;
  }

  brokerOf(id: string): FakeBackendBroker {
    const entry = this.entries.get(id);
    if (!entry?.broker) throw new Error(`unknown target: ${id}`);
    return entry.broker;
  }

  override async removeTarget(id: string): Promise<void> {
    this.entries.delete(id);
  }

  override listTargets(): RemoteTargetInfo[] {
    return [...this.entries.values()].map((entry) => ({
      id: entry.config.id ?? '',
      status: entry.connected ? ('connected' as const) : ('disconnected' as const),
    }));
  }

  override getTarget(id: string): RemoteTarget | undefined {
    return this.entries.get(id)?.config;
  }

  override get(_id: string): RemoteTransport | undefined {
    return undefined;
  }

  override status(id: string): ConnectionStatus {
    return this.entries.get(id)?.connected ? 'connected' : 'disconnected';
  }

  override runtimeRoot(_id: string): string | undefined {
    return '/fake/runtime';
  }

  override connect(id: string): Promise<RemoteTransport> {
    const entry = this.entries.get(id);
    if (!entry?.broker) return Promise.reject(new Error(`fake hub: unknown target: ${id}`));
    this.connectCalls++;
    entry.connected = true;
    return Promise.resolve(new FakeTransport(entry.broker, this.backendCommand));
  }

  override disconnect(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (entry) entry.connected = false;
    return Promise.resolve();
  }
}
