import { afterEach, describe, expect, it, vi } from 'vitest';
import { Notifications, type MonitorMetricsNotification } from '@dsh-remote/core';
import { MIN_INTERVAL_MS, MonitorCollector } from '../src/monitor.js';
import { fakeMonitorSources } from './fakes.js';

afterEach(() => {
  vi.useRealTimers();
});

function makeCollector(overrides?: Parameters<typeof fakeMonitorSources>[0]) {
  const notifications: { method: string; params: unknown }[] = [];
  const collector = new MonitorCollector({
    workspacePath: '/work',
    stats: () => ({ sessions: 2, attachedClients: 3 }),
    sources: fakeMonitorSources(overrides),
  });
  return { collector, notifications };
}

describe('MonitorCollector sampling', () => {
  it('parses cpu/load/memory/disk/process metrics from the sources', async () => {
    const { collector } = makeCollector();
    // First sample establishes the CPU baseline (no ratio yet).
    await collector.sample();
    const metrics = await collector.sample();
    expect(metrics.sessions).toBe(2);
    expect(metrics.attachedClients).toBe(3);
    expect(metrics.rssBytes).toBe(12_345);
    expect(metrics.loadAvg).toEqual([0.5, 1.0, 1.5]);
    expect(metrics.cpuBusyRatio).toBeCloseTo(0.3);
    expect(metrics.memTotalBytes).toBe(1024 * 1024);
    expect(metrics.memAvailableBytes).toBe(512 * 1024);
    expect(metrics.diskTotalBytes).toBe(2048 * 1024);
    expect(metrics.diskFreeBytes).toBe(1024 * 1024);
    expect(metrics.processCount).toBe(3);
    expect(Date.parse(metrics.ts)).not.toBeNaN();
  });

  it('degrades to missing fields when sources fail, never throwing', async () => {
    const { collector } = makeCollector({
      readProc: () => Promise.reject(new Error('no proc')),
      listProcEntries: () => Promise.reject(new Error('no proc')),
      df: () => Promise.reject(new Error('df exploded')),
      rssBytes: () => {
        throw new Error('no rss');
      },
    });
    const metrics = await collector.sample();
    expect(metrics.sessions).toBe(2);
    expect(metrics.rssBytes).toBeUndefined();
    expect(metrics.loadAvg).toBeUndefined();
    expect(metrics.cpuBusyRatio).toBeUndefined();
    expect(metrics.memTotalBytes).toBeUndefined();
    expect(metrics.diskTotalBytes).toBeUndefined();
    expect(metrics.processCount).toBeUndefined();
  });
});

describe('MonitorCollector subscriptions', () => {
  it('pushes monitor.metrics on the interval until unsubscribe', async () => {
    vi.useFakeTimers();
    const { collector, notifications } = makeCollector();
    const unsub = collector.subscribe(
      'client-1',
      (method, params) => notifications.push({ method, params }),
      1_000,
    );
    await vi.advanceTimersByTimeAsync(2_100);
    expect(notifications).toHaveLength(2);
    expect(notifications[0]!.method).toBe(Notifications.MonitorMetrics);
    unsub();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(notifications).toHaveLength(2);
  });

  it('clamps the interval to the floor and replaces re-subscriptions', async () => {
    vi.useFakeTimers();
    const { collector, notifications } = makeCollector();
    collector.subscribe('c', (m, p) => notifications.push({ method: m, params: p }), 1);
    await vi.advanceTimersByTimeAsync(MIN_INTERVAL_MS + 10);
    const count = notifications.length;
    expect(count).toBeGreaterThanOrEqual(1);
    // Re-subscribe: the old timer must be gone (no doubling).
    collector.subscribe('c', (m, p) => notifications.push({ method: m, params: p }), 1_000);
    await vi.advanceTimersByTimeAsync(2_100);
    expect(notifications.length).toBeLessThanOrEqual(count + 3);
    collector.dispose();
  });
});
