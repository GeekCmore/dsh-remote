/**
 * `@dsh-remote/remote-daemon` — daemon-mode frontend: the `ctx.remoteSessions`
 * provider (`@dsh-remote/sessions` seam) speaking the dsh-remote daemon
 * protocol (`@dsh-remote/core`) over an SSH exec channel obtained from
 * `ctx.remoteHub` (`@dsh-remote/remote`).
 *
 * The default export is the Cordis service class:
 * `ctx.plugin(DaemonRemoteSessions, { resolveToken })`.
 *
 * The service is a thin cordis adapter over `@dsh-remote/client`
 * ({@link RemoteClient} / {@link TargetConnection} / {@link DaemonAgentHandle});
 * the client types consumers need are re-exported here. The wire vocabulary
 * is exactly core `protocol.ts` — this package keeps no local protocol
 * literals.
 */
import { DaemonRemoteSessions } from './daemon-sessions.js';

export { DaemonRemoteSessions } from './daemon-sessions.js';
export {
  DaemonAgentHandle,
  RemoteClient,
  TargetConnection,
  connectorFromHub,
} from '@dsh-remote/client';
export type {
  DaemonAgentHandleOptions,
  HubLike,
  RemoteClientConfig,
  RemoteClientHandle,
  SessionSubscriber,
  TargetConnectionConfig,
  TargetConnector,
} from '@dsh-remote/client';

export default DaemonRemoteSessions;
