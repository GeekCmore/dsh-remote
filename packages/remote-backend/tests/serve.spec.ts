import { describe, expect, it } from 'vitest';
import {
  Methods,
  Notifications,
  type ApprovalRequestParams,
  type MonitorMetricsNotification,
} from '@dsh-remote/core';
import { TEST_TOKEN, handshake, makeWorld } from './fakes.js';
import { sleep, tick } from '@dsh-remote/test-utils';

describe('serve over the wire: lifecycle integration', () => {
  it('routes approval.request to the writer and approval.answer back', async () => {
    const world = makeWorld();
    const { clientId } = await handshake(world.client, TEST_TOKEN);
    world.sessions.add('s1');
    await world.client.call(Methods.SessionAttach, { sessionId: 's1', mode: 'write' });

    const requests: ApprovalRequestParams[] = [];
    world.client.onNotification(Methods.ApprovalRequest, (params) => {
      requests.push(params as ApprovalRequestParams);
    });
    const raised = world.approvalHost.raise({ sessionId: 's1', kind: 'exec', summary: 'do it' });
    await tick();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.summary).toBe('do it');

    await world.client.call(Methods.ApprovalAnswer, {
      requestId: requests[0]!.requestId,
      decision: 'approve',
    });
    await expect(raised).resolves.toEqual({ decision: 'approve' });
    expect(clientId).toBe('client-1');
  });

  it('pushes monitor.metrics after monitor.subscribe and stops on unsubscribe', async () => {
    const world = makeWorld();
    await handshake(world.client, TEST_TOKEN);
    const samples: MonitorMetricsNotification[] = [];
    world.client.onNotification(Notifications.MonitorMetrics, (params) => {
      samples.push(params as MonitorMetricsNotification);
    });
    await world.client.call(Methods.MonitorSubscribe, { intervalMs: 250 });
    await sleep(650);
    expect(samples.length).toBeGreaterThanOrEqual(2);
    expect(samples[0]!.loadAvg).toEqual([0.5, 1.0, 1.5]);

    await world.client.call(Methods.MonitorUnsubscribe);
    const settled = samples.length;
    await sleep(600);
    expect(samples.length).toBe(settled);
  });

  it('releases leases and subscriptions when the connection drops', async () => {
    const world = makeWorld();
    await handshake(world.client, TEST_TOKEN);
    world.sessions.add('s1');
    await world.client.call(Methods.SessionAttach, { sessionId: 's1', mode: 'write' });
    expect((await world.broker.list())[0]!.controller).toBe('client-1');

    // Client disappears (EOF on the server's inbound byte stream).
    world.serverInbound.end();
    await world.server.closed;
    await tick();
    const summary = (await world.broker.list())[0]!;
    expect(summary.controller).toBeNull();
    expect(summary.attachedClients).toBe(0);
  });
});
