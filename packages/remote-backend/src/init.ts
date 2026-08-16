/**
 * `dsh-remote-backend init [--rotate-token]`: generate the 256-bit pairing
 * token and write it to `~/.config/dsh-remote/backend.json` (dir 0700, file
 * 0600, atomic temp-file + rename — see config.ts). The token is printed to
 * stdout exactly once, for the user to carry back to the local frontend; it
 * is never logged afterwards. Re-running without `--rotate-token` refuses to
 * clobber an existing config, keeping the command idempotent and safe to
 * probe with.
 */
import { writeConfig } from './config.js';

export interface InitOptions {
  /** Config directory override (tests); defaults per config.ts. */
  configDir?: string;
  /** Replace an existing token (invalidates previously paired frontends). */
  rotateToken?: boolean;
  /** Where the one-time token line goes; defaults to console.log. */
  out?: (line: string) => void;
}

export interface InitResult {
  token: string;
  path: string;
  /** True when the token replaced an existing one. */
  rotated: boolean;
}

export async function runInit(options: InitOptions = {}): Promise<InitResult> {
  const out = options.out ?? ((line: string) => console.log(line));
  const { token, path } = await writeConfig(options.configDir, {
    overwrite: options.rotateToken === true,
  });
  out(`dsh-remote backend pairing token (shown once — store it in your local frontend):`);
  out(token);
  out(`written to ${path} (mode 0600)`);
  return { token, path, rotated: options.rotateToken === true };
}
