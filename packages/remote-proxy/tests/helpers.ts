/**
 * Shared unit-test harness: a real cordis `Context` with the proxy mounted
 * over a {@link RemoteClient} talking to the in-memory {@link FakeBackendBroker}
 * from `@dsh-remote/test-fakes`.
 */
import { Context } from '@deepseek-ai/cordis';
import { RemoteClient } from '@dsh-remote/client';
import { RemoteProxy } from '../src/index.js';
import { FakeBackendBroker, FakeTargetConnector } from '@dsh-remote/test-fakes';

export const TOKEN = 'pairing-token';
export const REF = 'tok-ref';

export interface ProxySetup {
  ctx: Context;
  broker: FakeBackendBroker;
  connector: FakeTargetConnector;
  client: RemoteClient;
  proxy: RemoteProxy;
}

export async function setupProxy(
  opts: { capabilities?: string[]; targetId?: string; broker?: FakeBackendBroker } = {},
): Promise<ProxySetup> {
  const ctx = new Context();
  const broker =
    opts.broker ??
    new FakeBackendBroker({
      token: TOKEN,
      ...(opts.capabilities !== undefined ? { capabilities: opts.capabilities } : {}),
    });
  const connector = new FakeTargetConnector();
  const targetId = opts.targetId ?? 't1';
  connector.addTarget(targetId, broker, REF);
  const client = new RemoteClient(connector, {
    resolveToken: async (ref: string) => {
      if (ref !== REF) throw new Error(`unknown token ref: ${ref}`);
      return TOKEN;
    },
    reconnect: { initialDelayMs: 5, maxDelayMs: 20 },
  });
  const proxy = new RemoteProxy(ctx, { targetId }, client);
  return { ctx, broker, connector, client, proxy };
}

export async function teardownProxy(s: ProxySetup): Promise<void> {
  await s.proxy.dispose();
  await s.client.dispose();
}
