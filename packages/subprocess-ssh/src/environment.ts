/**
 * Remote-environment baseline for SSH child processes — the provider-side
 * equivalent of the seam's `scrubbedParentEnv()`.
 *
 * The ambient *local* environment never leaks into the remote execution
 * world. Instead the baseline is probed once per live transport via
 * `RemoteTransport.probeLoginEnv`, then scrubbed with the seam's shared
 * `SENSITIVE_ENV_PATTERN` / `DSH_*` rules; explicit `spec.env` entries merge
 * afterwards (a deliberate string survives, `undefined` is a tombstone).
 */
import { DSH_ENV_PREFIX, SENSITIVE_ENV_PATTERN } from '@dsh-remote/seams';
import type { RemoteTransport } from '@dsh-remote/remote';
import { connLostError } from './util.js';

/** Login variables probed as the scrubbed baseline. */
const PROBE_VARS = [
  'HOME',
  'PATH',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TERM',
  'TMPDIR',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
];

const DEFAULT_PATH = '/usr/local/bin:/usr/bin:/bin';

/**
 * Lazily probed, per-transport cached remote baseline environment. The cache
 * is keyed by the transport object itself, so a reconnect (new transport
 * instance) invalidates it naturally.
 */
export class RemoteEnvironment {
  private readonly cache = new WeakMap<RemoteTransport, Promise<Record<string, string>>>();

  constructor(private readonly getTransport: () => RemoteTransport | undefined) {}

  /** The scrubbed remote login environment for the current connection. */
  base(): Promise<Record<string, string>> {
    const transport = this.getTransport();
    if (!transport) throw connLostError('probe remote environment');
    let cached = this.cache.get(transport);
    if (!cached) {
      cached = this.probe(transport);
      this.cache.set(transport, cached);
    }
    return cached;
  }

  private async probe(transport: RemoteTransport): Promise<Record<string, string>> {
    const probed = await transport.probeLoginEnv(PROBE_VARS);
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(probed)) {
      if (value === '') continue;
      if (SENSITIVE_ENV_PATTERN.test(name) || name.toUpperCase().startsWith(DSH_ENV_PREFIX)) continue;
      env[name] = value;
    }
    if (env.PATH === undefined) env.PATH = DEFAULT_PATH;
    return env;
  }
}

/**
 * Merge explicit spec entries onto a baseline, validating the wire format.
 * @returns NUL-joinable `name=value` entries for the wrapper's `env -i`.
 */
export function mergeEnvironment(
  base: Record<string, string>,
  explicit: NodeJS.ProcessEnv | Record<string, string> | undefined,
): string[] {
  const merged = new Map<string, string>(Object.entries(base));
  for (const [name, value] of Object.entries(explicit ?? {})) {
    if (name.length === 0 || name.includes('=') || name.includes('\0') || value?.includes('\0') === true) {
      throw new Error(
        'subprocess-ssh: environment entries require non-empty NUL-free names without = and NUL-free values',
      );
    }
    // An explicit undefined is the seam's tombstone: remove the ambient entry.
    if (value === undefined) merged.delete(name);
    else merged.set(name, value);
  }
  return [...merged].map(([name, value]) => `${name}=${value}`);
}
