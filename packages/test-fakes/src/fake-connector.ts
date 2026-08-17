/**
 * In-memory {@link TargetConnector} for daemon-client tests: `connect()` hands
 * out a {@link FakeBackendTransport} whose `exec(backendCommand)` spawns a
 * {@link FakeBackendBroker} channel. No cordis, no SSH, no network.
 *
 * Moved verbatim from `packages/remote-client/tests/fake-connector.ts`
 * (remote-proxy carried a byte-identical copy). The class satisfies
 * `@dsh-remote/client`'s `TargetConnector` STRUCTURALLY rather than via
 * `implements`: importing that type here would make this package depend on
 * `@dsh-remote/client`, whose own tests consume this package — a workspace
 * dependency cycle. `TargetConnector` is a deliberately structural interface
 * (see `packages/remote-client/src/connector.ts`), and every consumer passes
 * this class where a `TargetConnector` is expected, so the shape is still
 * checked at each use site.
 */
import type { ExecProcess, RemoteTransport } from '@dsh-remote/remote';
import { FakeBackendTransport } from './backend-transport.js';
import type { FakeBackendBroker } from './fake-backend.js';

export class FakeTargetConnector {
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
    const broker = entry.broker;
    return Promise.resolve(
      new FakeBackendTransport((): ExecProcess => broker.spawn(), this.backendCommand),
    );
  }

  pairingTokenRef(targetId: string): string | undefined {
    return this.entries.get(targetId)?.pairingTokenRef;
  }
}
