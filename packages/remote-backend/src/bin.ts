#!/usr/bin/env node
/**
 * `dsh-remote-backend` CLI.
 *
 * - `init [--rotate-token]`: generate/rotate the pairing token (see init.ts).
 * - `serve [--profile <name>]`: run the stdio protocol server. Without
 *   `--profile` there is NO dsh host behind it — session/agent calls see an
 *   empty world (useful for handshake and plumbing smoke tests). With
 *   `--profile` (the production daemon form) the bin boots the named dsh
 *   profile in-process via `@deepseek-ai/dsh-app-boot` (profile-boot.ts);
 *   the profile's `@dsh-remote/backend` plugin row (index.ts) then mounts
 *   the real `ctx.sessions`/`ctx.agents` narrowed through host.ts and takes
 *   over stdio.
 */
import { runInit } from './init.js';
import { parseServeArgs, serveProfile } from './profile-boot.js';
import { runServe } from './serve.js';
import type {
  AgentHostAccess,
  HostSession,
  SessionHostAccess,
} from './host.js';

const diag = (msg: string) => process.stderr.write(`${msg}\n`);

/** Host access with no sessions and no agents (standalone `serve`). */
function emptySessionHost(): SessionHostAccess {
  return {
    get: () => undefined,
    list: () => [],
    fork: (): HostSession => {
      throw new Error('no session host is attached (standalone serve)');
    },
    onSessionEvent: () => () => {},
    listCold: () => [],
  };
}

function emptyAgentHost(): AgentHostAccess {
  return { get: () => undefined };
}

async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  switch (command) {
    case 'init':
      await runInit({ rotateToken: args.includes('--rotate-token') });
      return;
    case 'serve': {
      let serveArgs;
      try {
        serveArgs = parseServeArgs(args);
      } catch (err) {
        diag(err instanceof Error ? err.message : String(err));
        process.exitCode = 2;
        return;
      }
      if (serveArgs.profile === undefined) {
        // Standalone: no dsh host, empty world (handshake smoke only).
        await runServe({
          sessions: emptySessionHost(),
          agents: emptyAgentHost(),
          diag,
        });
        return;
      }
      // Production form: boot the profile in-process; the profile's
      // @dsh-remote/backend plugin row takes over stdio during boot. Once
      // serveProfile returns, process lifetime belongs to the mounted tree
      // (same as `dsh --profile`). Boot failures fail loud on stderr with a
      // non-zero exit so the SSH exec channel surfaces them.
      try {
        await serveProfile(serveArgs.profile, { diag });
      } catch (err) {
        diag(err instanceof Error ? (err.stack ?? err.message) : String(err));
        process.exitCode = 1;
      }
      return;
    }
    case undefined:
    case '--help':
    case '-h':
      process.stderr.write(
        'usage: dsh-remote-backend <command>\n' +
          '  init [--rotate-token]   generate the pairing token (printed once)\n' +
          '  serve [--profile NAME]  run the stdio protocol server; without --profile an\n' +
          '                          empty host (handshake smoke only), with --profile boot\n' +
          '                          the named dsh profile in-process (production daemon form)\n',
      );
      return;
    default:
      diag(`unknown command "${command}"; try --help`);
      process.exitCode = 2;
  }
}

await main(process.argv.slice(2));
