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
import { randomUUID } from 'node:crypto';
import { runServe } from './serve.js';
import type {
  AgentHostAccess,
  ApprovalHostAccess,
  AttachmentsHostAccess,
  CatalogHostAccess,
  CompactionHostAccess,
  HostAgent,
  HostApprovalDecision,
  HostApprovalRequest,
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

/**
 * Narrow `ctx.agents` (upstream `AgentRegistry`) to {@link AgentHostAccess}.
 * The `create` half mirrors dsh-headless's runner: `AgentRegistry.create`
 * mints session AND agent under one caller-supplied id (the SessionId brand
 * is compile-time-only, so a plain `session-<uuid>` string crosses the cast),
 * and the provider/model route comes from the `agentDefaultModel` service's
 * `currentSelection()` (probed isolate-safely — OPTIONAL in principle, but a
 * model-less agent could never prompt, so without the service `create` is
 * left absent and the wire `session.create` degrades to
 * REMOTE_PROTOCOL_ERROR). A reasoningEffort on the selection is dropped:
 * `AgentOptions` carries provider/model/maxTokens only (headless applies the
 * effort through its scoped model-selection install, which this narrowing
 * cannot reach without importing the host's dsh-agent package).
 */
function agentAccessFromContext(ctx: Context): AgentHostAccess {
  const registry = (ctx as unknown as { agents: unknown }).agents as {
    get(id: string): HostAgent | undefined;
    create?(options: {
      sessionId: string;
      meta?: { cwd?: string };
      agentOptions?: { provider?: string; model?: string };
    }): Promise<{ agent: HostAgent }>;
  };
  const defaultModel = probeService<{
    currentSelection(): { provider: string; model: string; reasoningEffort?: string };
  }>(ctx, 'agentDefaultModel');
  const events = ctx as unknown as EventSource;
  return {
    get: (id) => registry.get(id),
    // Upstream `CreateAgentOptions.meta.cwd` must be absolute (the session
    // boundary validates and throws, which the broker surfaces as
    // REMOTE_PROTOCOL_ERROR). Upstream SessionHeader has no title field, so
    // the protocol title is dropped.
    ...(typeof registry.create === 'function' && defaultModel !== undefined
      ? {
          create: async (options: { cwd?: string; title?: string }) => {
            const selection = defaultModel.currentSelection();
            const handle = await registry.create!({
              sessionId: `session-${randomUUID()}`,
              ...(options.cwd !== undefined ? { meta: { cwd: options.cwd } } : {}),
              agentOptions: { provider: selection.provider, model: selection.model },
            });
            return handle.agent;
          },
        }
      : {}),
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
 * as a waterfall (`(request, next) => outcome`) whose request is the UPSTREAM
 * shape (`{agent, toolName, callId?, reason?, signal?}` — see
 * `@deepseek-ai/dsh-user-approval`) and whose resolution is an outcome string
 * (`'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`). The bridge
 * speaks the wire-facing {@link HostApprovalRequest} /
 * {@link HostApprovalDecision} pair, so this adapter translates BOTH ways:
 * `agent.session.id` / `toolName` / `reason` become sessionId / kind /
 * summary on the way in, and the bridge's approve/deny becomes the outcome
 * vocabulary on the way out — a deny whose note marks the answer channel as
 * missing maps to `'unavailable'`, every other deny to `'rejected'`.
 */
function approvalAccessFromContext(ctx: Context): ApprovalHostAccess {
  const events = ctx as unknown as EventSource;
  /** Structural view of the upstream waterfall request (dsh-user-approval). */
  interface UpstreamApprovalRequest {
    agent?: { session?: { id: unknown } };
    toolName?: string;
    callId?: string;
    reason?: string;
  }
  const toHostRequest = (req: UpstreamApprovalRequest): HostApprovalRequest => ({
    ...(req.agent?.session?.id !== undefined
      ? { sessionId: String(req.agent.session.id) }
      : {}),
    kind: req.toolName ?? 'unknown',
    summary: req.reason ?? '',
    ...(req.callId !== undefined ? { detail: { callId: req.callId } } : {}),
  });
  const toOutcome = (decision: HostApprovalDecision): string =>
    decision.decision === 'approve'
      ? 'allowed-once'
      : decision.note !== undefined && decision.note.includes('unavailable')
        ? 'unavailable'
        : 'rejected';
  const toDecision = (outcome: unknown): HostApprovalDecision =>
    outcome === 'allowed-once'
      ? { decision: 'approve' }
      : { decision: 'deny', note: `delegated host outcome: ${String(outcome)}` };
  return {
    onApprovalRequest: (handler) =>
      events.on(
        'approval/request',
        ((req: UpstreamApprovalRequest, next: () => Promise<unknown>) =>
          handler(toHostRequest(req), async () => toDecision(await next())).then(toOutcome)) as (
          ...args: never[]
        ) => void,
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
 * when the host has none. The upstream service and the daemon wire use
 * deliberately different shapes, so this is a bidirectional adapter rather
 * than a structural cast: questions/options are normalized on the way in and
 * the wire answer map is restored to upstream selected-label/custom answers
 * on the way out.
 */
function questionAccessFromContext(ctx: Context): QuestionHostAccess | undefined {
  interface UpstreamQuestionOption {
    label: string;
    description?: string;
  }
  interface UpstreamQuestionIntent {
    kind: 'plan-review';
    approve: string;
  }
  interface UpstreamQuestionItem {
    id: string;
    question: string;
    detail?: string;
    header?: string;
    options?: UpstreamQuestionOption[];
    multiSelect?: boolean;
    intent?: UpstreamQuestionIntent;
  }
  interface UpstreamQuestionRequest {
    questions: UpstreamQuestionItem[];
    agent?: { session?: { id: unknown } };
    signal?: AbortSignal;
  }
  interface UpstreamQuestionAnswerItem {
    id: string;
    selected: string[];
    custom?: string;
  }
  interface UpstreamQuestionAnswer {
    answers: UpstreamQuestionAnswerItem[];
  }
  const registry = probeService<{
    registerProvider(provider: {
      ask(request: UpstreamQuestionRequest): Promise<UpstreamQuestionAnswer>;
    }): () => void;
  }>(ctx, 'userQuestions');
  if (!registry) return undefined;
  return {
    registerProvider: (provider) =>
      registry.registerProvider({
        ask: async (request) => {
          const optionsByItem = new Map<string, Map<string, string>>();
          const items = request.questions.map((question) => {
            const optionLabels = new Map<string, string>();
            const options = (question.options ?? []).map((option, index) => {
              const id = `option-${index}`;
              optionLabels.set(id, option.label);
              return {
                id,
                label: option.label,
                ...(option.description !== undefined
                  ? { description: option.description }
                  : {}),
              };
            });
            optionsByItem.set(question.id, optionLabels);
            return {
              id: question.id,
              question: question.question,
              ...(question.detail !== undefined ? { detail: question.detail } : {}),
              ...(question.header !== undefined ? { header: question.header } : {}),
              ...(question.multiSelect !== undefined
                ? { multiSelect: question.multiSelect }
                : {}),
              ...(question.intent !== undefined ? { intent: question.intent } : {}),
              options,
            };
          });
          const hostAnswers = await provider.ask({
            ...(request.agent?.session?.id !== undefined
              ? { sessionId: String(request.agent.session.id) }
              : {}),
            ...(request.signal !== undefined ? { signal: request.signal } : {}),
            items,
          });
          const answers: UpstreamQuestionAnswerItem[] = [];
          for (const question of request.questions) {
            const value = hostAnswers[question.id];
            if (value === undefined) continue;
            if (!question.multiSelect && Array.isArray(value)) {
              throw new Error(`question "${question.id}" returned multiple answers for single-select item`);
            }
            const values = Array.isArray(value) ? value : [value];
            const labels = optionsByItem.get(question.id)!;
            const selected: string[] = [];
            const custom: string[] = [];
            for (const answer of values) {
              const label = labels.get(answer);
              if (label === undefined) custom.push(answer);
              else selected.push(label);
            }
            if (custom.length > 1) {
              throw new Error(`question "${question.id}" returned more than one custom answer`);
            }
            answers.push({
              id: question.id,
              selected,
              ...(custom[0] !== undefined ? { custom: custom[0] } : {}),
            });
          }
          return { answers };
        },
      }),
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
