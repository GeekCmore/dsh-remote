/**
 * `@dsh-remote/remote-daemon` — daemon-mode frontend: the `ctx.remoteSessions`
 * provider (`@dsh-remote/sessions` seam) speaking the dsh-remote daemon
 * protocol (`@dsh-remote/core`) over an SSH exec channel obtained from
 * `ctx.remoteHub` (`@dsh-remote/remote`).
 *
 * The default export is the Cordis service class:
 * `ctx.plugin(DaemonRemoteSessions, { resolveToken })`.
 *
 * The wire vocabulary is exactly core `protocol.ts`: `session.create` /
 * `session.attach` / event envelopes and client identity (backend-assigned in
 * the handshake) all come from there — this package keeps no local protocol
 * literals.
 */
import { DaemonRemoteSessions } from './daemon-sessions.js';

export { DaemonRemoteSessions } from './daemon-sessions.js';
export { DaemonAgentHandle } from './handle.js';
export type { DaemonAgentHandleOptions } from './handle.js';
export { TargetConnection } from './connection.js';
export type { SessionSubscriber, TargetConnectionConfig } from './connection.js';

export default DaemonRemoteSessions;
