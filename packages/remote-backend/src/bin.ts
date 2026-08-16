#!/usr/bin/env node
/**
 * `dsh-remote-backend` CLI.
 *
 * - `init [--rotate-token]`: generate/rotate the pairing token (see init.ts).
 * - `serve`: run the stdio protocol server. Standalone serve has NO dsh host
 *   behind it — session/agent calls see an empty world (useful for handshake
 *   and plumbing smoke tests). The production path is the Cordis plugin
 *   (index.ts) mounted into a headless dsh, which calls runServe with the
 *   real `ctx.sessions`/`ctx.agents` narrowed through host.ts.
 */
import { runInit } from './init.js';
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
    case 'serve':
      await runServe({
        sessions: emptySessionHost(),
        agents: emptyAgentHost(),
        diag,
      });
      return;
    case undefined:
    case '--help':
    case '-h':
      process.stderr.write(
        'usage: dsh-remote-backend <command>\n' +
          '  init [--rotate-token]   generate the pairing token (printed once)\n' +
          '  serve                   run the stdio protocol server (empty host standalone;\n' +
          '                          mount the Cordis plugin for a real dsh host)\n',
      );
      return;
    default:
      diag(`unknown command "${command}"; try --help`);
      process.exitCode = 2;
  }
}

await main(process.argv.slice(2));
