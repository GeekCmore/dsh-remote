/**
 * Cordis plugin entry: `@dsh-remote/backend` mounted into a headless remote
 * dsh. `apply` narrows the real `ctx.sessions` / `ctx.agents` / approval
 * waterfall through the structural interfaces in host.ts (double-cast at
 * exactly this boundary) and starts the stdio protocol server.
 *
 * The casts are safe by construction: host.ts declares precisely the members
 * this package reads, and each member maps 1:1 to an upstream signature
 * (see the host.ts module doc for the mapping). A host that drifts from
 * those signatures fails fast at the first call, inside this plugin only.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { SessionEvent } from '@dsh-remote/seams';
import { runServe } from './serve.js';
import type {
  AgentHostAccess,
  ApprovalHostAccess,
  AttachmentsHostAccess,
  CatalogHostAccess,
  CompactionHostAccess,
  HostAgent,
  HostQuestionAnswers,
  HostQuestionRequest,
  HostSession,
  PersistenceHostAccess,
  QuestionHostAccess,
  SessionHostAccess,
} from './host.js';

export const name = 'dsh-remote-backend';

export { SessionBroker } from './broker.js';
export { ApprovalBridge } from './approval.js';
export { QuestionBridge } from './question.js';
export { MonitorCollector } from './monitor.js';
export type { MonitorSources, MonitorOptions } from './monitor.js';
export { TransferManager } from './transfer.js';
export { BackendServer, runServe } from './serve.js';
export { runInit } from './init.js';
export { loadToken, configPath, configDir } from './config.js';
export type * from './host.js';

/** Minimal view of cordis `ctx.on` used for host event subscriptions. */
interface EventSource {
  on(name: string, listener: (...args: never[]) => void): () => void;
}

/**
 * Narrow `ctx.sessions` (upstream `SessionStore`) to {@link SessionHostAccess}.
 * Upstream `SessionId` is a branded string; the brand is compile-time-only,
 * so plain strings cross the boundary unchanged.
 */
function sessionAccessFromContext(ctx: Context): SessionHostAccess {
  const store = (ctx as unknown as { sessions: unknown }).sessions as {
    get(id: string): HostSession | undefined;
    list(): HostSession[];
    fork(source: string, boundary?: number): HostSession;
  };
  const events = ctx as unknown as EventSource;
  return {
    get: (id) => store.get(id),
    list: () => store.list(),
    // Upstream `boundary` is already an inclusive event boundary, so the
    // protocol's fork-at-seq rewind (`atSeq`) maps onto it directly.
    fork: (source, boundary, atSeq) => {
      const effective = boundary ?? atSeq;
      return effective === undefined ? store.fork(source) : store.fork(source, effective);
    },
    onSessionEvent: (listener) =>
      events.on('session/event', (session, event) =>
        listener(session as unknown as HostSession, event as unknown as SessionEvent),
      ),
    onSessionDisposed: (listener) =>
      events.on('session/disposed', (session) => listener(session as unknown as HostSession)),
  };
}

/** Narrow `ctx.agents` (upstream `AgentRegistry`) to {@link AgentHostAccess}. */
function agentAccessFromContext(ctx: Context): AgentHostAccess {
  const registry = (ctx as unknown as { agents: unknown }).agents as {
    get(id: string): HostAgent | undefined;
  };
  const events = ctx as unknown as EventSource;
  return {
    get: (id) => registry.get(id),
    onStatus: (listener) =>
      events.on('agent/status', (payload) => {
        const { agent, status } = payload as unknown as {
          agent: HostAgent;
          status: 'idle' | 'running';
        };
        listener(agent, status);
      }),
  };
}

/**
 * Narrow the host approval waterfall. Real dsh dispatches `approval/request`
 * as a waterfall (`(request, next) => decision`); the bridge awaits the
 * remote answer before resolving the waterfall.
 */
function approvalAccessFromContext(ctx: Context): ApprovalHostAccess {
  const events = ctx as unknown as EventSource;
  return {
    onApprovalRequest: (handler) =>
      events.on(
        'approval/request',
        handler as (...args: never[]) => void,
      ),
  };
}

/**
 * Narrow `ctx.sessionPersistence` (upstream SessionPersistence). OPTIONAL:
 * returns undefined when the host has no persistence service, in which case
 * the `history` capability is not advertised.
 */
function persistenceAccessFromContext(ctx: Context): PersistenceHostAccess | undefined {
  const persistence = (ctx as unknown as { sessionPersistence?: unknown }).sessionPersistence as
    | {
        inspect(id: string): unknown;
        readFrom(id: string, fromSeq?: number): unknown;
        list(): unknown;
      }
    | undefined;
  if (!persistence) return undefined;
  return {
    inspect: (id) => persistence.inspect(id) as ReturnType<PersistenceHostAccess['inspect']>,
    readFrom: (id, fromSeq) =>
      persistence.readFrom(id, fromSeq) as ReturnType<PersistenceHostAccess['readFrom']>,
    list: () => persistence.list() as ReturnType<PersistenceHostAccess['list']>,
  };
}

/**
 * Narrow `ctx.userQuestions` (upstream provider registry for
 * ask_user_question). OPTIONAL: undefined when the host has none.
 */
function questionAccessFromContext(ctx: Context): QuestionHostAccess | undefined {
  const registry = (ctx as unknown as { userQuestions?: unknown }).userQuestions as
    | {
        registerProvider(provider: {
          ask(request: HostQuestionRequest): Promise<HostQuestionAnswers>;
        }): () => void;
      }
    | undefined;
  if (!registry) return undefined;
  return {
    registerProvider: (provider) => registry.registerProvider(provider),
  };
}

/**
 * Narrow the read-only catalog services (`ctx.llm`, `ctx.skills`,
 * `ctx.agentPresets`). OPTIONAL per member: a host may expose any subset.
 * Returns undefined when none of the three exist.
 */
function catalogAccessFromContext(ctx: Context): CatalogHostAccess | undefined {
  const source = ctx as unknown as {
    llm?: CatalogHostAccess['llm'];
    skills?: CatalogHostAccess['skills'];
    agentPresets?: CatalogHostAccess['agentPresets'];
  };
  const out: CatalogHostAccess = {
    ...(source.llm !== undefined ? { llm: source.llm } : {}),
    ...(source.skills !== undefined ? { skills: source.skills } : {}),
    ...(source.agentPresets !== undefined ? { agentPresets: source.agentPresets } : {}),
  };
  return out.llm || out.skills || out.agentPresets ? out : undefined;
}

/**
 * Narrow `ctx.compaction` (@deepseek-ai/dsh-compaction). OPTIONAL: undefined
 * when the host has no compaction service.
 */
function compactionAccessFromContext(ctx: Context): CompactionHostAccess | undefined {
  const compaction = (ctx as unknown as { compaction?: unknown }).compaction as
    | { compactNow(agent: HostAgent, signal?: AbortSignal): Promise<unknown> }
    | undefined;
  if (!compaction) return undefined;
  return {
    compactNow: (agent, signal) => compaction.compactNow(agent, signal),
  };
}

/**
 * Narrow `ctx.attachments` (image prompt blocks). OPTIONAL: undefined when
 * the host has no attachment store.
 */
function attachmentsAccessFromContext(ctx: Context): AttachmentsHostAccess | undefined {
  const attachments = (ctx as unknown as { attachments?: unknown }).attachments as
    | AttachmentsHostAccess
    | undefined;
  if (!attachments) return undefined;
  return {
    saveImage: (input) => attachments.saveImage(input),
  };
}

export function apply(ctx: Context): void {
  const diag = (msg: string) => {
    try {
      (ctx as unknown as { logger?: { warn(msg: string): void } }).logger?.warn(msg);
    } catch {
      // logger unavailable: fall through to stderr
    }
    process.stderr.write(`[dsh-remote-backend] ${msg}\n`);
  };
  const persistenceHost = persistenceAccessFromContext(ctx);
  const questionHost = questionAccessFromContext(ctx);
  const catalogHost = catalogAccessFromContext(ctx);
  const compactionHost = compactionAccessFromContext(ctx);
  const attachmentsHost = attachmentsAccessFromContext(ctx);
  void runServe({
    sessions: sessionAccessFromContext(ctx),
    agents: agentAccessFromContext(ctx),
    approvalHost: approvalAccessFromContext(ctx),
    ...(persistenceHost !== undefined ? { persistenceHost } : {}),
    ...(questionHost !== undefined ? { questionHost } : {}),
    ...(catalogHost !== undefined ? { catalogHost } : {}),
    ...(compactionHost !== undefined ? { compactionHost } : {}),
    ...(attachmentsHost !== undefined ? { attachmentsHost } : {}),
    diag,
  }).catch((err: unknown) => {
    diag(`serve failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}

export default { name, apply };
