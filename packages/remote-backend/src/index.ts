/**
 * Cordis plugin entry: `@dsh-remote/backend` mounted into a headless remote
 * dsh. `apply` narrows the real `ctx.sessions` / `ctx.agents` / approval
 * waterfall through the structural interfaces in host.ts (double-cast at
 * exactly this boundary) and starts the stdio protocol server. Required
 * services are gate-kept by the row's `inject` declaration; optional
 * services are probed isolate-safely via `ctx.get` (see probeService).
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
 * Soft probe for OPTIONAL host services, safe under the loader isolate.
 *
 * The cordis loader runs every entry in an isolate where plain property
 * access (`ctx.sessionPersistence`) THROWS for any service the row did not
 * declare via `inject` — yet declaring a hard `inject` on a service the
 * profile never provides deadlocks activation. `ctx.get` (the reflect
 * mixin) reads the service store WITHOUT the inject requirement and yields
 * undefined for absent services, which is exactly the optional-probe
 * semantic. Non-strict (`false`) because activation is availability-driven:
 * at apply() time a provider may have registered its implementation while
 * its fiber is still starting, and the value is already constructed.
 *
 * REQUIRED services (sessions, agents) are NOT probed this way — the row's
 * `inject: [sessions, agents]` declaration gates activation on them, so the
 * narrowings below read them as plain properties.
 */
function probeService<T>(ctx: Context, name: string): T | undefined {
  try {
    return ctx.get(name, false) as T | undefined;
  } catch {
    // A host without the reflect mixin (non-loader contexts) degrades to
    // "service absent" rather than failing the plugin.
    return undefined;
  }
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
    create(id?: string, options?: { meta?: { cwd?: string } }): HostSession;
    fork(source: string, boundary?: number): HostSession;
  };
  const events = ctx as unknown as EventSource;
  return {
    get: (id) => store.get(id),
    list: () => store.list(),
    // Upstream `SessionStore.create(id?, options?)`: the id is omitted (the
    // store mints `session-<n>`) and the protocol's cwd folds into
    // `options.meta`; meta.cwd must be absolute (upstream validates and
    // throws, which the broker surfaces as REMOTE_PROTOCOL_ERROR). Upstream
    // SessionHeader has no title field, so the protocol title is dropped.
    create: (options) =>
      store.create(
        undefined,
        options.cwd !== undefined ? { meta: { cwd: options.cwd } } : undefined,
      ),
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
 * probed via {@link probeService}; returns undefined when the host has no
 * persistence service, in which case the `history` capability is not
 * advertised.
 */
function persistenceAccessFromContext(ctx: Context): PersistenceHostAccess | undefined {
  const persistence = probeService<{
    inspect(id: string): unknown;
    readFrom(id: string, fromSeq?: number): unknown;
    list(): unknown;
  }>(ctx, 'sessionPersistence');
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
 * ask_user_question). OPTIONAL: probed via {@link probeService}; undefined
 * when the host has none.
 */
function questionAccessFromContext(ctx: Context): QuestionHostAccess | undefined {
  const registry = probeService<{
    registerProvider(provider: {
      ask(request: HostQuestionRequest): Promise<HostQuestionAnswers>;
    }): () => void;
  }>(ctx, 'userQuestions');
  if (!registry) return undefined;
  return {
    registerProvider: (provider) => registry.registerProvider(provider),
  };
}

/**
 * Narrow the read-only catalog services (`ctx.llm`, `ctx.skills`,
 * `ctx.agentPresets`). OPTIONAL per member, each probed via
 * {@link probeService}: a host may expose any subset. Returns undefined when
 * none of the three exist.
 */
function catalogAccessFromContext(ctx: Context): CatalogHostAccess | undefined {
  const llm = probeService<CatalogHostAccess['llm']>(ctx, 'llm');
  const skills = probeService<CatalogHostAccess['skills']>(ctx, 'skills');
  const agentPresets = probeService<CatalogHostAccess['agentPresets']>(ctx, 'agentPresets');
  const out: CatalogHostAccess = {
    ...(llm !== undefined && llm !== null ? { llm } : {}),
    ...(skills !== undefined && skills !== null ? { skills } : {}),
    ...(agentPresets !== undefined && agentPresets !== null ? { agentPresets } : {}),
  };
  return out.llm || out.skills || out.agentPresets ? out : undefined;
}

/**
 * Narrow `ctx.compaction` (@deepseek-ai/dsh-compaction). OPTIONAL: probed
 * via {@link probeService}; undefined when the host has no compaction
 * service.
 */
function compactionAccessFromContext(ctx: Context): CompactionHostAccess | undefined {
  const compaction = probeService<{
    compactNow(agent: HostAgent, signal?: AbortSignal): Promise<unknown>;
  }>(ctx, 'compaction');
  if (!compaction) return undefined;
  return {
    compactNow: (agent, signal) => compaction.compactNow(agent, signal),
  };
}

/**
 * Narrow `ctx.attachments` (image prompt blocks). OPTIONAL: probed via
 * {@link probeService}; undefined when the host has no attachment store.
 */
function attachmentsAccessFromContext(ctx: Context): AttachmentsHostAccess | undefined {
  const attachments = probeService<AttachmentsHostAccess>(ctx, 'attachments');
  if (!attachments) return undefined;
  return {
    saveImage: (input) => attachments.saveImage(input),
  };
}

/**
 * The full set of host narrowings apply() hands to runServe. Exported for
 * tests: the isolate-safe probing and the create/listCold wiring are unit
 * tested against a fake context without booting a server.
 */
export interface HostAccess {
  sessions: SessionHostAccess;
  agents: AgentHostAccess;
  approvalHost: ApprovalHostAccess;
  persistenceHost?: PersistenceHostAccess;
  questionHost?: QuestionHostAccess;
  catalogHost?: CatalogHostAccess;
  compactionHost?: CompactionHostAccess;
  attachmentsHost?: AttachmentsHostAccess;
}

/**
 * Build every host narrowing from a real plugin context. REQUIRED services
 * (sessions, agents) are read as properties — the row declares them via
 * `inject`, so activation guarantees them; OPTIONAL services are probed
 * through {@link probeService} (isolate-safe soft access). The broker's
 * `listCold` hook is wired to the persistence index here: upstream cold
 * sessions live in `SessionPersistence.list()`, not in the live store.
 */
export function hostAccessFromContext(ctx: Context): HostAccess {
  const sessions = sessionAccessFromContext(ctx);
  const persistenceHost = persistenceAccessFromContext(ctx);
  if (persistenceHost) {
    sessions.listCold = () => persistenceHost.list();
  }
  const questionHost = questionAccessFromContext(ctx);
  const catalogHost = catalogAccessFromContext(ctx);
  const compactionHost = compactionAccessFromContext(ctx);
  const attachmentsHost = attachmentsAccessFromContext(ctx);
  return {
    sessions,
    agents: agentAccessFromContext(ctx),
    approvalHost: approvalAccessFromContext(ctx),
    ...(persistenceHost !== undefined ? { persistenceHost } : {}),
    ...(questionHost !== undefined ? { questionHost } : {}),
    ...(catalogHost !== undefined ? { catalogHost } : {}),
    ...(compactionHost !== undefined ? { compactionHost } : {}),
    ...(attachmentsHost !== undefined ? { attachmentsHost } : {}),
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
  const host = hostAccessFromContext(ctx);
  void runServe({
    sessions: host.sessions,
    agents: host.agents,
    approvalHost: host.approvalHost,
    ...(host.persistenceHost !== undefined ? { persistenceHost: host.persistenceHost } : {}),
    ...(host.questionHost !== undefined ? { questionHost: host.questionHost } : {}),
    ...(host.catalogHost !== undefined ? { catalogHost: host.catalogHost } : {}),
    ...(host.compactionHost !== undefined ? { compactionHost: host.compactionHost } : {}),
    ...(host.attachmentsHost !== undefined ? { attachmentsHost: host.attachmentsHost } : {}),
    diag,
  }).catch((err: unknown) => {
    diag(`serve failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}

export default { name, apply };
