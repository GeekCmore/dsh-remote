/**
 * `ctx.remoteMonitor`: periodic read-only health probes for live targets.
 *
 * Collection runs over the target's existing `RemoteTransport` exec channel —
 * no extra connection is opened. Each tick runs ONE aggregate sh command whose
 * output is framed by fixed `@@section` markers; parsing is fault-tolerant
 * (missing sections degrade individual fields, missing required sections
 * degrade the whole sample to an error snapshot without stopping the poll).
 *
 * Probe inventory (all read-only):
 *   /proc/loadavg, /proc/meminfo (MemTotal/MemAvailable), /proc/stat (the
 *   aggregate `cpu` line; utilization is derived from two consecutive
 *   samples), `df -P <runtimeRoot>` and `ps -e --no-headers | wc -l`.
 */
import { Context, Service } from '@deepseek-ai/cordis';
import type { RemoteHub } from '@dsh-remote/remote';

declare module '@deepseek-ai/cordis' {
  interface Context {
    remoteMonitor: RemoteMonitor;
  }

  interface Events {
    /** One emit per collected (or degraded) metrics sample. */
    'remote/metrics'(targetId: string, metrics: RemoteMetrics): void;
  }
}

/** One metrics sample for a target. */
export interface RemoteMetrics {
  /** Collection time, ms since epoch. */
  at: number;
  loadavg: [number, number, number];
  memTotalBytes: number;
  memAvailableBytes: number;
  /** CPU busy ratio over the last two samples; absent on the first sample. */
  cpuBusyRatio?: number;
  diskTotalBytes?: number;
  diskFreeBytes?: number;
  processCount?: number;
  /** Set when collection failed; other fields then repeat the last known values (or zeros). */
  error?: string;
}

export interface RemoteMonitorConfig {
  /** Default poll interval; per-target `start` options override. */
  intervalMs?: number;
}

interface CpuJiffies {
  busy: number;
  total: number;
}

interface RunningState {
  timer: ReturnType<typeof setInterval>;
  prevCpu?: CpuJiffies;
}

const DEFAULT_INTERVAL_MS = 5_000;

/** Single-quote a string for POSIX sh. */
function sq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The aggregate probe command; output sections are framed by `@@name` marker lines. */
export function buildMetricsProbeCommand(dfPath: string): string {
  return [
    "{ echo '@@loadavg'; cat /proc/loadavg;",
    "echo '@@mem'; grep -E '^(MemTotal|MemAvailable):' /proc/meminfo;",
    "echo '@@cpu'; head -n 1 /proc/stat;",
    `echo '@@df'; df -P ${sq(dfPath)} | tail -n 1;`,
    "echo '@@ps'; ps -e --no-headers | wc -l; } 2>/dev/null",
  ].join(' ');
}

/** Parsed sections of one probe output; any field may be absent. */
export interface ParsedMetricsProbe {
  loadavg?: [number, number, number];
  memTotalBytes?: number;
  memAvailableBytes?: number;
  cpu?: CpuJiffies;
  diskTotalBytes?: number;
  diskFreeBytes?: number;
  processCount?: number;
}

/** Fault-tolerant parser for {@link buildMetricsProbeCommand} output. */
export function parseMetricsProbe(stdout: string): ParsedMetricsProbe {
  const sections = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('@@')) {
      current = [];
      sections.set(line.slice(2).trim(), current);
    } else if (current) {
      current.push(line);
    }
  }
  const out: ParsedMetricsProbe = {};

  const load = sections.get('loadavg')?.join(' ').trim().split(/\s+/);
  if (load && load.length >= 3) {
    const a = Number(load[0]);
    const b = Number(load[1]);
    const c = Number(load[2]);
    if (Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(c)) {
      out.loadavg = [a, b, c];
    }
  }

  for (const line of sections.get('mem') ?? []) {
    const m = /^Mem(Total|Available):\s+(\d+)\s*kB/.exec(line.trim());
    if (!m) continue;
    const bytes = Number(m[2]) * 1024;
    if (m[1] === 'Total') out.memTotalBytes = bytes;
    else out.memAvailableBytes = bytes;
  }

  const cpuLine = sections.get('cpu')?.find((l) => /^cpu\s/.test(l));
  if (cpuLine) {
    const fields = cpuLine.trim().split(/\s+/).slice(1).map(Number);
    // user nice system idle iowait irq softirq steal — guest columns excluded.
    if (fields.length >= 4 && fields.slice(0, 8).every(Number.isFinite)) {
      const usable = fields.slice(0, 8);
      const total = usable.reduce((n, v) => n + v, 0);
      const idle = (usable[3] ?? 0) + (usable[4] ?? 0);
      out.cpu = { busy: total - idle, total };
    }
  }

  const dfLines = (sections.get('df') ?? []).filter((l) => l.trim().length > 0);
  const df = dfLines[dfLines.length - 1]?.trim().split(/\s+/);
  if (df && df.length >= 4) {
    const totalKb = Number(df[1]);
    const availKb = Number(df[3]);
    if (Number.isFinite(totalKb)) out.diskTotalBytes = totalKb * 1024;
    if (Number.isFinite(availKb)) out.diskFreeBytes = availKb * 1024;
  }

  const ps = Number(sections.get('ps')?.join('').trim());
  if (Number.isInteger(ps) && ps >= 0) out.processCount = ps;

  return out;
}

export class RemoteMonitor extends Service {
  private readonly defaultIntervalMs: number;
  private readonly running = new Map<string, RunningState>();
  private readonly snapshots = new Map<string, RemoteMetrics>();

  constructor(ctx: Context, config: RemoteMonitorConfig = {}) {
    super(ctx, 'remoteMonitor');
    this.defaultIntervalMs = config.intervalMs ?? DEFAULT_INTERVAL_MS;
    // Dropping the connection makes polling pointless; stop automatically.
    ctx.on('remote/disconnected', (targetId) => this.stop(targetId));
    ctx.on('remote/degraded', (targetId) => this.stop(targetId));
    ctx.effect(() => () => this.stopAll());
  }

  /** Start polling a target. Idempotent: a running target is left alone. */
  start(targetId: string, opts: { intervalMs?: number } = {}): void {
    if (this.running.has(targetId)) return;
    const state: RunningState = {
      timer: setInterval(() => {
        void this.collect(targetId);
      }, opts.intervalMs ?? this.defaultIntervalMs),
    };
    this.running.set(targetId, state);
    state.timer.unref?.();
    void this.collect(targetId);
  }

  /** Stop polling a target; the last snapshot stays cached. No-op when not running. */
  stop(targetId: string): void {
    const state = this.running.get(targetId);
    if (!state) return;
    clearInterval(state.timer);
    this.running.delete(targetId);
  }

  /** The most recent snapshot for a target (including degraded ones). */
  snapshot(targetId: string): RemoteMetrics | undefined {
    return this.snapshots.get(targetId);
  }

  /** Stop every running poll. */
  stopAll(): void {
    for (const targetId of [...this.running.keys()]) this.stop(targetId);
  }

  // -------------------------------------------------------------- private

  private hub(): RemoteHub | undefined {
    // The augmentation declares the service; at runtime it may be absent.
    return this.ctx.remoteHub as RemoteHub | undefined;
  }

  private async collect(targetId: string): Promise<void> {
    const state = this.running.get(targetId);
    if (!state) return;
    try {
      const transport = this.hub()?.get(targetId);
      if (!transport) throw new Error('no live connection');
      const dfPath = this.hub()?.runtimeRoot(targetId) ?? '/';
      const proc = await transport.exec(buildMetricsProbeCommand(dfPath));
      const chunks: Uint8Array[] = [];
      for await (const chunk of proc.stdout) chunks.push(chunk);
      await proc.done;
      const parsed = parseMetricsProbe(new TextDecoder('utf-8').decode(concat(chunks)));
      if (
        !parsed.loadavg ||
        parsed.memTotalBytes === undefined ||
        parsed.memAvailableBytes === undefined
      ) {
        throw new Error('incomplete probe output');
      }
      const metrics: RemoteMetrics = {
        at: Date.now(),
        loadavg: parsed.loadavg,
        memTotalBytes: parsed.memTotalBytes,
        memAvailableBytes: parsed.memAvailableBytes,
      };
      if (parsed.cpu && state.prevCpu && parsed.cpu.total > state.prevCpu.total) {
        const ratio = (parsed.cpu.busy - state.prevCpu.busy) / (parsed.cpu.total - state.prevCpu.total);
        metrics.cpuBusyRatio = Math.min(1, Math.max(0, ratio));
      }
      if (parsed.cpu) state.prevCpu = parsed.cpu;
      if (parsed.diskTotalBytes !== undefined) metrics.diskTotalBytes = parsed.diskTotalBytes;
      if (parsed.diskFreeBytes !== undefined) metrics.diskFreeBytes = parsed.diskFreeBytes;
      if (parsed.processCount !== undefined) metrics.processCount = parsed.processCount;
      this.publish(targetId, metrics);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const last = this.snapshots.get(targetId);
      // Degraded snapshot: keep polling; repeat last known values when present.
      const degraded: RemoteMetrics = last
        ? { ...last, at: Date.now(), error: message }
        : { at: Date.now(), loadavg: [0, 0, 0], memTotalBytes: 0, memAvailableBytes: 0, error: message };
      this.publish(targetId, degraded);
    }
  }

  /** Fire-and-forget: emit the sample and cache it. */
  private publish(targetId: string, metrics: RemoteMetrics): void {
    this.snapshots.set(targetId, metrics);
    this.ctx.emit('remote/metrics', targetId, metrics);
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export default RemoteMonitor;
