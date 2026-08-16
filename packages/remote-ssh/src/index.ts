/**
 * `@dsh-remote/remote-ssh`: ssh2-backed implementation of the
 * `@dsh-remote/remote` service definition — `SshTransport` (one ssh2
 * connection per target) and `SshRemoteHub` (the `ctx.remoteHub` provider).
 *
 * The default export is the Cordis plugin: `ctx.plugin(SshRemoteHub, config)`
 * registers the `remoteHub` service on the context.
 */

export {
  SshTransport,
  type SshAuth,
  type SshConnectHooks,
  type SshTargetConfig,
} from './ssh-transport.js';
export { SshRemoteHub } from './hub-ssh.js';

export { SshRemoteHub as default } from './hub-ssh.js';
