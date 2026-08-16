/**
 * `@dsh-remote/remote`: service definition for `ctx.remoteHub` — the
 * connection-owner seam of dsh-remote's live mode.
 *
 * Definition only: the abstract {@link RemoteHub} class, the transport SPI
 * ({@link RemoteTransport}, {@link SftpLike}, exec vocabulary), and the SSH
 * target vocabulary types. There is no plugin here; the ssh2-backed
 * implementation and its Cordis plugin live in `@dsh-remote/remote-ssh`.
 */

export * from './transport.js';
export {
  RemoteHub,
  type ConnectionStatus,
  type RemoteTarget,
  type RemoteTargetInfo,
} from './hub.js';
