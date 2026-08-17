/**
 * `dsh-remote-backend serve --profile <name>`: in-process dsh profile boot.
 *
 * The production daemon channel is ONE ssh exec process — this bin. With
 * `--profile` it boots a dsh profile (via `@deepseek-ai/dsh-app-boot`, the
 * same library `dsh --profile` uses) whose tree contains the
 * `@dsh-remote/backend` plugin row; the Cordis plugin (index.ts `apply`)
 * then mounts against the real host services and takes over stdio itself.
 * This module is only the launcher half: resolve the profile, compose its
 * patch layers like the `dsh` CLI does (bundle layers in
 * `dsh.profile.bundles` order, then the profile's own `cordis.patch.yml`),
 * and drive `boot()`. Unlike the CLI it mounts no HMR/user-patch watchers
 * (a daemon exec process is restarted, not hot-reloaded) and applies no
 * home-level patch layer (the remote profile must be self-contained).
 *
 * stdout hygiene (hard constraint — stdout carries ONLY protocol frames
 * written by serve.ts): cordis itself never writes stdout (its Logger
 * service buffers until an exporter is mounted) and the boot-path packages
 * (dsh-app-boot / loader / include / timer) emit no console output, but
 * profile plugins are arbitrary code, so before booting we redirect
 * console.log/info/debug to stderr (console.warn/error already target
 * stderr and are left alone). This mirrors the upstream dsh-headless
 * precedent, where only the runner's own result write touches stdout.
 *
 * `@deepseek-ai/dsh-app-boot` is an OPTIONAL peer: it is imported
 * dynamically only on this code path, so standalone `serve` (empty host,
 * handshake smoke) runs without it installed. The `import type` below is
 * erased at compile time and costs nothing at runtime.
 */
import { existsSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'node:util';

const BIN = 'dsh-remote-backend';

/** Plugin row the booted profile must mount for stdio to be served. */
const BACKEND_PLUGIN_NAME = '@dsh-remote/backend';

/** Root config filename inside the profile directory (same as `dsh --profile`). */
const PROFILE_ROOT_FILENAME = 'cordis.yml';

/**
 * The empty root entry list every profile tree patches over. Rewritten on
 * every boot for the same reason the `dsh` CLI rewrites it: the vendored
 * Loader's tree write-back can bake composed rows into this file, which
 * would duplicate every bundle insert on the next boot.
 */
const PROFILE_ROOT_CONFIG =
  `# dsh-remote-backend profile root — an empty entry list. The tree is composed as\n` +
  `# patches: each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml.\n` +
  `# Edit cordis.patch.yml, not this file.\n` +
  `[]\n`;

/** The slice of `@deepseek-ai/dsh-app-boot` this launcher uses. */
export type AppBootModule = Pick<
  typeof import('@deepseek-ai/dsh-app-boot'),
  'boot' | 'installFailLoud' | 'loadProfile' | 'resolveProfileDir'
>;

/** Structural view of the settled boot context used by the post-boot audit. */
interface BootedContextView {
  loader?: {
    entries(): Iterable<{ options: { name?: string }; disabled?: boolean }>;
  };
  fiber?: { dispose(): Promise<void> };
}

/** Parsed `serve` arguments. `profile` absent means standalone empty host. */
export interface ServeArgs {
  profile?: string;
}

/**
 * Parse `serve` flags. Only `--profile <name>` (or `--profile=<name>`) is
 * known; anything else is a usage error so a typo fails loud instead of
 * silently serving the empty standalone host.
 */
export function parseServeArgs(args: string[]): ServeArgs {
  let profile: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--profile') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${BIN}: serve --profile requires a profile name`);
      }
      profile = value;
      i += 1;
    } else if (arg.startsWith('--profile=')) {
      const value = arg.slice('--profile='.length);
      if (value === '') throw new Error(`${BIN}: serve --profile requires a profile name`);
      profile = value;
    } else {
      throw new Error(`${BIN}: unknown serve argument "${arg}"`);
    }
  }
  return profile === undefined ? {} : { profile };
}

/**
 * Route boot-time `console.log`/`info`/`debug` to stderr. Idempotent:
 * wrappers are rebuilt from the live stderr stream on every call, so repeat
 * calls (tests) never stack. console.warn/error already write to stderr.
 */
export function redirectConsoleToStderr(): void {
  const write = (args: unknown[]) => {
    process.stderr.write(`${format(...args)}\n`);
  };
  console.log = (...args: unknown[]) => write(args);
  console.info = (...args: unknown[]) => write(args);
  console.debug = (...args: unknown[]) => write(args);
}

async function importAppBoot(): Promise<AppBootModule> {
  try {
    return await import('@deepseek-ai/dsh-app-boot');
  } catch (cause) {
    throw new Error(
      `${BIN}: serve --profile requires the optional peer @deepseek-ai/dsh-app-boot; ` +
        `install it next to ${BIN} on the remote host`,
      { cause },
    );
  }
}

export interface ServeProfileOptions {
  /** Pre-loaded dsh-app-boot module (tests inject a fake). */
  appBoot?: AppBootModule;
  /** Diagnostic sink (defaults to stderr). */
  diag?: (msg: string) => void;
}

/**
 * Boot the named dsh profile in this process and return once the tree has
 * settled — by then the mounted `@dsh-remote/backend` plugin owns stdio and
 * process lifetime. Throws (fail loud, non-zero exit by the caller) when the
 * profile does not exist, when boot rejects, or when the settled tree has no
 * enabled backend plugin row.
 */
export async function serveProfile(
  profileName: string,
  options: ServeProfileOptions = {},
): Promise<void> {
  const diag = options.diag ?? ((msg: string) => process.stderr.write(`${msg}\n`));
  // Redirect before any plugin code can run (boot mounts entries whose
  // apply() may log); serve.ts's protocol writes bypass console entirely.
  redirectConsoleToStderr();
  const appBoot = options.appBoot ?? (await importAppBoot());

  const profileDir = appBoot.resolveProfileDir(profileName);
  if (!existsSync(profileDir)) {
    throw new Error(
      `${BIN}: profile "${profileName}" not found at ${profileDir} — ` +
        `expected a dsh profile at $DSH_HOME/profiles/${profileName}/ ` +
        `(package.json with dsh.profile.bundles + cordis.patch.yml)`,
    );
  }

  // First bundle-resolution anchor. The `dsh` CLI passes its own app
  // package.json here; we pass ours, so in-box bundles (dsh-base, …) fall
  // through to the profile directory's node_modules — the deployment
  // contract is "the profile installs everything it composes".
  const installAnchor = fileURLToPath(new URL('../package.json', import.meta.url));
  const profile = appBoot.loadProfile(BIN, profileName, installAnchor);
  const rootConfig = join(profile.dir, PROFILE_ROOT_FILENAME);
  writeFileSync(rootConfig, PROFILE_ROOT_CONFIG);
  const patches = [...profile.layers.flatMap((layer) => layer.patches), ...profile.patches];

  appBoot.installFailLoud(BIN);
  const ctx = (await appBoot.boot(BIN, rootConfig, patches)) as unknown as BootedContextView;

  // boot() settled: its final audit already threw for any failed or
  // never-activating enabled entry, so an enabled backend row means the
  // plugin's apply() ran and took over stdio. No row (or a disabled one)
  // leaves this process silent on the protocol channel — fail loud instead.
  const mounted = [...(ctx.loader?.entries() ?? [])].some(
    (entry) => entry.options.name === BACKEND_PLUGIN_NAME && !entry.disabled,
  );
  if (!mounted) {
    await ctx.fiber?.dispose().catch(() => {});
    throw new Error(
      `${BIN}: profile "${profileName}" does not mount ${BACKEND_PLUGIN_NAME} — ` +
        `add an enabled plugin row to the profile's cordis.patch.yml, e.g.\n` +
        `  - insert:\n` +
        `      - id: dsh-remote-backend\n` +
        `        name: '${BACKEND_PLUGIN_NAME}'`,
    );
  }
  diag(`${BIN}: profile "${profileName}" booted; ${BACKEND_PLUGIN_NAME} owns stdio`);
}
