import { describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { RemoteHub } from '@dsh-remote/remote';
import type { RemoteTarget, RemoteTargetInfo, RemoteTransport } from '@dsh-remote/remote';
import {
  RemoteMonitor,
  buildMetricsProbeCommand,
  parseMetricsProbe,
} from '../src/monitor.js';
import type { RemoteMetrics } from '../src/monitor.js';
import { FakeTransport } from './fake-transport.js';

class FakeHub extends RemoteHub {
  constructor(
    ctx: Context,
    private transport: FakeTransport | undefined,
    private readonly root = '/home/fake/.cache/dsh-remote/abc123',
  ) {
    super(ctx);
  }

  override addTarget(_config: RemoteTarget): string {
    return 't1';
  }

  override removeTarget(): Promise<void> {
    return Promise.resolve();
  }

  override listTargets(): RemoteTargetInfo[] {
    return [];
  }

  override getTarget(): RemoteTarget | undefined {
    return undefined;
  }

  override get(): FakeTransport | undefined {
    return this.transport;
  }

  override status(): 'connected' {
    return 'connected';
  }

  override runtimeRoot(): string {
    return this.root;
  }

  override connect(): Promise<RemoteTransport> {
    return Promise.resolve(this.transport!);
  }

  override disconnect(): Promise<void> {
    return Promise.resolve();
  }

  dropConnection(): void {
    this.transport = undefined;
  }
}

function setup(fixture?: (fake: FakeTransport) => void) {
  const ctx = new Context();
  const fake = new FakeTransport();
  fixture?.(fake);
  const hub = new FakeHub(ctx, fake);
  const monitor = new RemoteMonitor(ctx);
  const events: Array<{ targetId: string; metrics: RemoteMetrics }> = [];
  ctx.on('remote/metrics', (targetId, metrics) => events.push({ targetId, metrics }));
  return { ctx, fake, hub, monitor, events };
}

describe('buildMetricsProbeCommand / parseMetricsProbe', () => {
  it('embeds the df path single-quoted', () => {
    const cmd = buildMetricsProbeCommand("/home/fake/it's");
    expect(cmd).toContain("df -P '/home/fake/it'\\''s' | tail -n 1");
  });

  it('parses a complete probe frame', async () => {
    const fake = new FakeTransport();
    const parsed = parseMetricsProbe(await probeOutputOf(fake));
    expect(parsed.loadavg).toEqual([0.1, 0.2, 0.3]);
    expect(parsed.memTotalBytes).toBe(16_384_000 * 1024);
    expect(parsed.memAvailableBytes).toBe(8_192_000 * 1024);
    // cpu fields: 100 0 100 700 50 0 0 0 → total 950, idle+iowait 750, busy 200
    expect(parsed.cpu).toEqual({ busy: 200, total: 950 });
    expect(parsed.diskTotalBytes).toBe(1_024_000 * 1024);
    expect(parsed.diskFreeBytes).toBe(512_000 * 1024);
    expect(parsed.processCount).toBe(123);
  });

  it('tolerates missing sections and garbage lines', () => {
    const parsed = parseMetricsProbe('@@loadavg\nnot numbers\n@@garbage\n?!?\n');
    expect(parsed.loadavg).toBeUndefined();
    expect(parsed.memTotalBytes).toBeUndefined();
    expect(parsed.cpu).toBeUndefined();
    expect(parsed.processCount).toBeUndefined();
  });
});

async function probeOutputOf(fake: FakeTransport): Promise<string> {
  // Pull the simulated probe output through the real exec surface.
  const proc = await fake.exec(buildMetricsProbeCommand('/'));
  const chunks: Uint8Array[] = [];
  for await (const chunk of proc.stdout) chunks.push(chunk);
  return new TextDecoder().decode(
    chunks.reduce((acc, c) => {
      const next = new Uint8Array(acc.length + c.length);
      next.set(acc);
      next.set(c, acc.length);
      return next;
    }, new Uint8Array(0)),
  );
}

describe('RemoteMonitor', () => {
  it('collects a full sample immediately on start and caches it', async () => {
    const { monitor, events } = setup();
    monitor.start('t1', { intervalMs: 10_000 });
    await vi.waitFor(() => expect(events.length).toBe(1));
    const m = events[0]!.metrics;
    expect(events[0]!.targetId).toBe('t1');
    expect(m.loadavg).toEqual([0.1, 0.2, 0.3]);
    expect(m.memTotalBytes).toBe(16_384_000 * 1024);
    expect(m.memAvailableBytes).toBe(8_192_000 * 1024);
    expect(m.diskTotalBytes).toBe(1_024_000 * 1024);
    expect(m.diskFreeBytes).toBe(512_000 * 1024);
    expect(m.processCount).toBe(123);
    expect(m.error).toBeUndefined();
    // No ratio on the first sample: it needs two cpu readings.
    expect(m.cpuBusyRatio).toBeUndefined();
    expect(monitor.snapshot('t1')).toEqual(m);
    monitor.stop('t1');
  });

  it('derives cpuBusyRatio from two consecutive samples', async () => {
    const { fake, monitor, events } = setup();
    monitor.start('t1', { intervalMs: 10 });
    await vi.waitFor(() => expect(events.length).toBeGreaterThanOrEqual(1));
    // Second sample: +100 user, +100 system, +700 idle, +50 iowait.
    const before = events.length;
    fake.fixture.cpuFields = '200 0 200 1400 100 0 0 0 0 0';
    await vi.waitFor(() =>
      expect(events.some((e) => e.metrics.cpuBusyRatio !== undefined)).toBe(true),
    );
    const m = events.find((e) => e.metrics.cpuBusyRatio !== undefined)!.metrics;
    // Δbusy = 200, Δtotal = 950 → 0.2105…
    expect(m.cpuBusyRatio).toBeCloseTo(200 / 950, 5);
    monitor.stop('t1');
  });

  it('emits a degraded snapshot on collection failure without stopping the poll', async () => {
    const { fake, monitor, events } = setup();
    monitor.start('t1', { intervalMs: 10 });
    await vi.waitFor(() => expect(events.length).toBeGreaterThanOrEqual(1));
    const before = events.length;
    fake.failExec = true;
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(before));
    const degraded = events[events.length - 1]!.metrics;
    expect(degraded.error).toContain('connection lost');
    // Required fields repeat the last known values.
    expect(degraded.loadavg).toEqual([0.1, 0.2, 0.3]);
    // Poll recovers once exec works again.
    fake.failExec = false;
    const recovered = events.length;
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(recovered));
    expect(events[events.length - 1]!.metrics.error).toBeUndefined();
    monitor.stop('t1');
  });

  it('degrades with zeros when there is no previous snapshot', async () => {
    const { hub, monitor, events } = setup();
    hub.dropConnection();
    monitor.start('t1', { intervalMs: 10 });
    await vi.waitFor(() => expect(events.length).toBeGreaterThanOrEqual(1));
    const m = events[0]!.metrics;
    expect(m.error).toBe('no live connection');
    expect(m.loadavg).toEqual([0, 0, 0]);
    expect(m.memTotalBytes).toBe(0);
    monitor.stop('t1');
  });

  it('start is idempotent and stop halts the poll', async () => {
    const { fake, monitor, events } = setup();
    monitor.start('t1', { intervalMs: 10 });
    monitor.start('t1', { intervalMs: 10 }); // no-op
    await vi.waitFor(() => expect(events.length).toBeGreaterThanOrEqual(2));
    monitor.stop('t1');
    monitor.stop('t1'); // no-op
    const execAtStop = fake.execCount;
    const eventsAtStop = events.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events.length).toBe(eventsAtStop);
    expect(fake.execCount).toBe(execAtStop);
  });

  it('stops automatically when the connection drops (remote/disconnected)', async () => {
    const { ctx, fake, monitor, events } = setup();
    monitor.start('t1', { intervalMs: 10 });
    await vi.waitFor(() => expect(events.length).toBeGreaterThanOrEqual(1));
    ctx.emit('remote/disconnected', 't1');
    const eventsAtDrop = events.length;
    const execAtDrop = fake.execCount;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events.length).toBe(eventsAtDrop);
    expect(fake.execCount).toBe(execAtDrop);
    // The last snapshot stays available after the auto-stop.
    expect(monitor.snapshot('t1')).toBeDefined();
  });

  it('snapshot is undefined for a target never collected', () => {
    const { monitor } = setup();
    expect(monitor.snapshot('unknown')).toBeUndefined();
  });
});
