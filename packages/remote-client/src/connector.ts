/**
 * {@link TargetConnector}: the narrow slice of a remote-target registry that
 * the daemon client actually uses — transport connect plus pairing-token-ref
 * resolution. Declared structurally so this package stays cordis-free; a
 * cordis `RemoteHub` (`@dsh-remote/remote`) satisfies the shape as-is, and
 * {@link connectorFromHub} adapts it explicitly.
 */
import type { RemoteTransport } from '@dsh-remote/remote';

/** Structural transport/pairing-ref source for {@link TargetConnection}. */
export interface TargetConnector {
  /**
   * Connect to a target, idempotently (concurrent calls share one attempt),
   * and return its live transport. Same contract as `RemoteHub.connect`.
   */
  connect(targetId: string): Promise<RemoteTransport>;
  /**
   * The pairing-token reference registered for a target, or undefined when
   * the target is unknown or not bootstrapped for daemon mode.
   */
  pairingTokenRef(targetId: string): string | undefined;
}

/** Structural minimum of a cordis `RemoteHub` that {@link connectorFromHub} needs. */
export interface HubLike {
  connect(id: string): Promise<RemoteTransport>;
  getTarget(id: string): { pairingTokenRef?: string } | undefined;
}

/** Adapt a cordis `RemoteHub` (or any {@link HubLike}) to a {@link TargetConnector}. */
export function connectorFromHub(hub: HubLike): TargetConnector {
  return {
    connect: (targetId) => hub.connect(targetId),
    pairingTokenRef: (targetId) => hub.getTarget(targetId)?.pairingTokenRef,
  };
}
