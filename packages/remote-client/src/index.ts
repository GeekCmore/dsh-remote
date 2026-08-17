/**
 * `@dsh-remote/client` — the cordis-free dsh-remote daemon-protocol client:
 * per-target daemon channels ({@link TargetConnection}) with pairing
 * handshake + reconnect/seq-cursor resume, session handles
 * ({@link DaemonAgentHandle}) covering the full core protocol vocabulary, and
 * the {@link RemoteClient} registry tying them together.
 *
 * The handle/type vocabulary declared here is the single source of truth for
 * the daemon-mode frontend; `@dsh-remote/sessions` re-exports it and adds the
 * cordis `Service` declaration, `@dsh-remote/remote-daemon` adapts
 * {@link RemoteClient} onto a cordis context.
 */
export { RemoteClient } from './client.js';
export type { RemoteClientConfig } from './client.js';
export { TargetConnection, CLIENT_CAPABILITIES } from './connection.js';
export type { SessionSubscriber, TargetConnectionConfig } from './connection.js';
export { connectorFromHub } from './connector.js';
export type { HubLike, TargetConnector } from './connector.js';
export { DaemonAgentHandle } from './handle.js';
export type { DaemonAgentHandleOptions } from './handle.js';
export type {
  AgentPresetSummary,
  ApprovalRequestParams,
  AttachOptions,
  CatalogKind,
  CatalogListResult,
  CatalogModel,
  ControlChangeReason,
  CreateRemoteSessionOptions,
  ForkOptions,
  HistoryEntry,
  HistoryOptions,
  HistoryPage,
  ModelProviderGroup,
  PendingInteraction,
  PromptContentBlock,
  PromptInput,
  QuestionAnswers,
  QuestionItem,
  QuestionOption,
  QuestionRequestParams,
  RemoteAgentHandle,
  RemoteAgentStatus,
  RemoteAttachMode,
  RemoteClientHandle,
  RemoteSessionState,
  RemoteSessionSummary,
  SkillSummary,
  WireSessionEvent,
} from './types.js';
