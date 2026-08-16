/**
 * MonitorCollector: periodic host-metrics sampling for `monitor.subscribe`.
 *
 * Sources (all Linux): CPU busy ratio and load from /proc/stat +
 * /proc/loadavg, memory from /proc/meminfo, workspace filesystem usage from
 * `df -P`, process count from a /proc scan. Every sample wraps each source
 * individually: a failing source simply leaves its fields ABSENT from the
 * `monitor.metrics` notification — monitoring must never break sessions.
 *
 * Sources are injectable (`MonitorSources`) so tests run fully in memory.
 */
import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { Notifications, type MonitorMetricsNotification } from '@dsh-remote/core';

const execFileAsync = promisify(execFile);

/** Minimum interval the collector honors, regardless of the request. */
export const MIN_INTERVAL_MS = 250;
/** Default push interval when the client does not specify one. */
export const DEFAULT_INTERVAL_MS = 2_000;

/** Injectable metric sources; defaults read the real host. */
export interface MonitorSources {
  readProc(relativePath: string): Promise<string>;
  listProcEntries(): Promise<string[]>;
  df(path: string): Promise<string>;
  rssBytes(): number;
}

export function defaultMonitorSources(): MonitorSources {
  return {
    readProc: (rel) => readFile(`/proc/${rel}`, 'utf8'),
    listProcEntries: () => readdir('/proc'),
    df: async (path) => {
      const { stdout } = await execFileAsync('df', ['-P', path]);
      return stdout;
    },
    rssBytes: () => process.memoryUsage().rss,
  };
}

export interface MonitorOptions {
  /** Workspace path for the disk sample (df -P target). */
  workspacePath: string;
  /** Aggregate session/attach counts folded into every sample. */
  stats(): { sessions: number; attachedClients: number };
  sources?: MonitorSources;
}

interface Subscription {
  timer: ReturnType<typeof setInterval>;
}

export class MonitorCollector {
  #options: MonitorOptions;
  #sources: MonitorSources;
  #subscriptions = new Map<string, Subscription>();
  /** Previous /proc/stat jiffy counters, for the delta-based CPU ratio. */
  #prevCpu: { busy: number; total: number } | undefined;

  constructor(options: MonitorOptions) {
    this.#options = options;
    this.#sources = options.sources ?? defaultMonitorSources();
  }

  /**
   * Start pushing `monitor.metrics` to `notify` every `intervalMs` (clamped
   * to {@link MIN_INTERVAL_MS}). One subscription per key; subscribing again
   * replaces the interval. Returns an unsubscribe disposer.
   */
  subscribe(key: string, notify: (method: string, params: unknown) => void, intervalMs?: number): () => void {
    this.unsubscribe(key);
    const interval = Math.max(MIN_INTERVAL_MS, intervalMs ?? DEFAULT_INTERVAL_MS);
    const timer = setInterval(() => {
      void this.sample().then(
        (metrics) => notify(Notifications.MonitorMetrics, metrics),
        () => {},
      );
    }, interval);
    timer.unref?.();
    this.#subscriptions.set(key, { timer });
    return () => this.unsubscribe(key);
  }

  /** Stop the subscription for `key` (also called on disconnect). */
  unsubscribe(key: string): void {
    const sub = this.#subscriptions.get(key);
    if (!sub) return;
    clearInterval(sub.timer);
    this.#subscriptions.delete(key);
  }

  /** Stop everything (plugin unload). */
  dispose(): void {
    for (const key of [...this.#subscriptions.keys()]) this.unsubscribe(key);
  }

  /** Take one sample; failing sources degrade to missing fields. */
  async sample(): Promise<MonitorMetricsNotification> {
    const { sessions, attachedClients } = this.#options.stats();
    const metrics: MonitorMetricsNotification = {
      ts: new Date().toISOString(),
      sessions,
      attachedClients,
    };
    try {
      metrics.rssBytes = this.#sources.rssBytes();
    } catch {
      // degraded: field absent
    }
    await Promise.all([
      this.#sampleCpu(metrics),
      this.#sampleLoad(metrics),
      this.#sampleMemory(metrics),
      this.#sampleDisk(metrics),
      this.#sampleProcesses(metrics),
    ]);
    return metrics;
  }

  async #sampleCpu(metrics: MonitorMetricsNotification): Promise<void> {
    try {
      const stat = await this.#sources.readProc('stat');
      const line = stat.split('\n')[0] ?? '';
      const parts = line.trim().split(/\s+/).slice(1).map(Number);
      if (parts.length < 8 || parts.some((n) => Number.isNaN(n))) return;
      const idle = (parts[3] ?? 0) + (parts[4] ?? 0); // idle + iowait
      const total = parts.reduce((acc, n) => acc + n, 0);
      const busy = total - idle;
      if (this.#prevCpu && total > this.#prevCpu.total) {
        const busyDelta = busy - this.#prevCpu.busy;
        const totalDelta = total - this.#prevCpu.total;
        metrics.cpuBusyRatio = Math.min(1, Math.max(0, busyDelta / totalDelta));
      }
      this.#prevCpu = { busy, total };
    } catch {
      // degraded: field absent
    }
  }

  async #sampleLoad(metrics: MonitorMetricsNotification): Promise<void> {
    try {
      const text = await this.#sources.readProc('loadavg');
      const parts = text.trim().split(/\s+/).map(Number);
      if (parts.length >= 3 && !parts.slice(0, 3).some((n) => Number.isNaN(n))) {
        metrics.loadAvg = [parts[0]!, parts[1]!, parts[2]!];
      }
    } catch {
      // degraded: field absent
    }
  }

  async #sampleMemory(metrics: MonitorMetricsNotification): Promise<void> {
    try {
      const text = await this.#sources.readProc('meminfo');
      const total = /^MemTotal:\s+(\d+)\s+kB$/m.exec(text);
      const available = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(text);
      if (total) metrics.memTotalBytes = Number(total[1]) * 1024;
      if (available) metrics.memAvailableBytes = Number(available[1]) * 1024;
    } catch {
      // degraded: field absent
    }
  }

  async #sampleDisk(metrics: MonitorMetricsNotification): Promise<void> {
    try {
      const text = await this.#sources.df(this.#options.workspacePath);
      const line = text.trim().split('\n')[1];
      if (!line) return;
      const parts = line.trim().split(/\s+/);
      // df -P: Filesystem 1024-blocks Used Available Capacity Mounted on
      const totalKb = Number(parts[1]);
      const availKb = Number(parts[3]);
      if (!Number.isNaN(totalKb)) metrics.diskTotalBytes = totalKb * 1024;
      if (!Number.isNaN(availKb)) metrics.diskFreeBytes = availKb * 1024;
    } catch {
      // degraded: field absent
    }
  }

  async #sampleProcesses(metrics: MonitorMetricsNotification): Promise<void> {
    try {
      const entries = await this.#sources.listProcEntries();
      metrics.processCount = entries.filter((name) => /^\d+$/.test(name)).length;
    } catch {
      // degraded: field absent
    }
  }
}
