/**
 * Wiring tests for index.ts's host narrowings (hostAccessFromContext):
 *
 * - agents.create adapts the protocol's `{cwd, title}` onto upstream
 *   `AgentRegistry.create({sessionId, meta, agentOptions})` (session+agent
 *   minted together; title dropped; cwd may be absent → meta omitted
 *   entirely; provider/model from the probed agentDefaultModel service);
 * - agents.create is left absent when the host has no agentDefaultModel
 *   service (a model-less agent could never prompt);
 * - sessions.listCold is wired to the persistence index (upstream
 *   `SessionPersistence.list()` — async, SessionHeader-shaped);
 * - optional services are probed via `ctx.get(name, false)` (the isolate-safe
 *   soft access): absent services and a throwing get (the loader isolate's
 *   hard-isolation behavior) both degrade to "capability off".
 */
import { describe, expect, it } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { hostAccessFromContext } from '../src/index.js';
import type { HostAgent, HostSession } from '../src/host.js';

interface FakeUpstreamStore {
  get(id: string): HostSession | undefined;
  list(): HostSession[];
  fork(source: string, boundary?: number): HostSession;
}

interface FakeAgentCreateCall {
  sessionId: string;
  meta?: { cwd?: string };
  agentOptions?: { provider?: string; model?: string };
}

interface FakeUpstreamRegistry {
  createCalls: FakeAgentCreateCall[];
  get(id: string): HostAgent | undefined;
  create(options: FakeAgentCreateCall): Promise<{ agent: HostAgent }>;
}

function fakeStore(): FakeUpstreamStore {
  const sessions = new Map<string, HostSession>();
  const mint = (id: string): HostSession => {
    const session: HostSession = {
      id,
      header: { createdAt: 1 },
      events: [],
      seq: 0,
    };
    sessions.set(id, session);
    return session;
  };
  return {
    get: (id) => sessions.get(id),
    list: () => [...sessions.values()],
    fork: (source) => mint(`${source}-fork`),
  };
}

function fakeRegistry(): FakeUpstreamRegistry {
  const agents = new Map<string, HostAgent>();
  const calls: FakeAgentCreateCall[] = [];
  return {
    createCalls: calls,
    get: (id) => agents.get(id),
    create: async (options) => {
      calls.push(options);
      const agent: HostAgent = {
        id: options.sessionId,
        status: 'idle',
        followup: () => {},
        cancel: () => {},
      };
      agents.set(agent.id, agent);
      return { agent };
    },
  };
}

const DEFAULT_MODEL = {
  currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
};

/** Fake plugin context: property access for required services, ctx.get for probes. */
function fakeContext(
  options: {
    store?: FakeUpstreamStore;
    registry?: FakeUpstreamRegistry;
    services?: Record<string, unknown>;
    getThrows?: boolean;
  } = {},
): {
  ctx: Context;
  store: FakeUpstreamStore;
  registry: FakeUpstreamRegistry;
  getCalls: string[];
  listeners: Array<{ name: string; listener: (...args: never[]) => unknown }>;
} {
  const store = options.store ?? fakeStore();
  const registry = options.registry ?? fakeRegistry();
  const services = options.services ?? {};
  const getCalls: string[] = [];
  const listeners: Array<{ name: string; listener: (...args: never[]) => unknown }> = [];
  const ctx = {
    sessions: store,
    agents: registry,
    on: (name: string, listener: (...args: never[]) => unknown) => {
      listeners.push({ name, listener });
      return () => {};
    },
    get: (name: string, _strict?: boolean) => {
      getCalls.push(name);
      if (options.getThrows) throw new Error(`isolate: service "${name}" not injected`);
      return services[name];
    },
  } as unknown as Context;
  return { ctx, store, registry, getCalls, listeners };
}

describe('hostAccessFromContext agents.create wiring', () => {
  it('adapts {cwd, title} to create({sessionId, meta, agentOptions}), dropping the title', async () => {
    const { ctx, registry } = fakeContext({ services: { agentDefaultModel: DEFAULT_MODEL } });
    const host = hostAccessFromContext(ctx);
    const agent = await host.agents.create!({ cwd: '/home/dsh/work', title: 'ignored' });
    expect(agent.id).toMatch(/^session-/);
    expect(registry.createCalls).toHaveLength(1);
    const call = registry.createCalls[0]!;
    expect(call.sessionId).toBe(agent.id);
    expect(call.meta).toEqual({ cwd: '/home/dsh/work' });
    expect(call.agentOptions).toEqual({ provider: 'deepseek', model: 'deepseek-chat' });
    // The minted agent is live in the registry under the same id.
    expect(host.agents.get(agent.id)).toBe(agent);
  });

  it('omits meta entirely when no cwd is given', async () => {
    const { ctx, registry } = fakeContext({ services: { agentDefaultModel: DEFAULT_MODEL } });
    const host = hostAccessFromContext(ctx);
    await host.agents.create!({});
    expect(registry.createCalls[0]!.meta).toBeUndefined();
  });

  it('leaves create absent when the host has no agentDefaultModel service', () => {
    const { ctx } = fakeContext();
    const host = hostAccessFromContext(ctx);
    expect(host.agents.create).toBeUndefined();
    expect(host.agents.get('nope')).toBeUndefined();
  });
});

describe('hostAccessFromContext approval waterfall adaptation', () => {
  /** Wire a handler through approvalHost and return the captured upstream listener. */
  function upstreamListener(
    handler: (
      request: unknown,
      next: () => Promise<unknown>,
    ) => Promise<{ decision: 'approve' | 'deny'; note?: string }>,
  ): (...args: never[]) => unknown {
    const { ctx, listeners } = fakeContext();
    hostAccessFromContext(ctx).approvalHost.onApprovalRequest(handler as never);
    const entry = listeners.find((l) => l.name === 'approval/request');
    expect(entry).toBeDefined();
    return entry!.listener;
  }

  const UPSTREAM_REQ = {
    agent: { session: { id: 'session-1' } },
    toolName: 'bash',
    callId: 'call-1',
    reason: 'escalate sandbox to danger-full-access: need /var/tmp',
  };
  const neverNext = (() => {
    throw new Error('next must not be called when the handler owns the request');
  }) as never;

  it('maps the upstream request shape onto HostApprovalRequest and approve to allowed-once', async () => {
    let hostReq: unknown;
    const listener = upstreamListener(async (req) => {
      hostReq = req;
      return { decision: 'approve' };
    });
    const outcome = await listener(UPSTREAM_REQ as never, neverNext);
    expect(hostReq).toEqual({
      sessionId: 'session-1',
      kind: 'bash',
      summary: 'escalate sandbox to danger-full-access: need /var/tmp',
      detail: { callId: 'call-1' },
    });
    expect(outcome).toBe('allowed-once');
  });

  it('maps deny to rejected, and an unavailable-marked deny to unavailable', async () => {
    const rejecting = upstreamListener(async () => ({ decision: 'deny', note: 'user said no' }));
    await expect(rejecting(UPSTREAM_REQ as never, neverNext)).resolves.toBe('rejected');
    const unavailable = upstreamListener(async () => ({
      decision: 'deny',
      note: 'unavailable: no frontend attached',
    }));
    await expect(unavailable(UPSTREAM_REQ as never, neverNext)).resolves.toBe('unavailable');
  });

  it('adapts the delegated next() outcome back into a HostApprovalDecision', async () => {
    const listener = upstreamListener(async (_req, next) => next() as never);
    await expect(
      listener(UPSTREAM_REQ as never, (async () => 'allowed-once') as never),
    ).resolves.toBe('allowed-once');
    const listenerDenied = upstreamListener(async (_req, next) => next() as never);
    await expect(
      listenerDenied(UPSTREAM_REQ as never, (async () => 'cancelled') as never),
    ).resolves.toBe('rejected');
  });

  it('omits sessionId when the upstream request carries no agent session', async () => {
    let hostReq: unknown;
    const listener = upstreamListener(async (req) => {
      hostReq = req;
      return { decision: 'approve' };
    });
    await listener({ toolName: 'bash', reason: 'host-level ask' } as never, neverNext);
    expect(hostReq).toEqual({ kind: 'bash', summary: 'host-level ask' });
  });
});

describe('hostAccessFromContext user-question adaptation', () => {
  interface UpstreamRequest {
    questions: Array<{
      id: string;
      question: string;
      detail?: string;
      header?: string;
      options?: Array<{ label: string; description?: string }>;
      multiSelect?: boolean;
      intent?: { kind: 'plan-review'; approve: string };
    }>;
    agent?: { session?: { id: string } };
    signal?: AbortSignal;
  }
  interface UpstreamAnswer {
    answers: Array<{ id: string; selected: string[]; custom?: string }>;
  }

  function upstreamProvider(
    askHost: (request: unknown) => Promise<Record<string, string | string[]>>,
  ): (request: UpstreamRequest) => Promise<UpstreamAnswer> {
    let provider:
      | { ask(request: UpstreamRequest): Promise<UpstreamAnswer> }
      | undefined;
    const service = {
      registerProvider(next: { ask(request: UpstreamRequest): Promise<UpstreamAnswer> }) {
        provider = next;
        return () => {
          provider = undefined;
        };
      },
    };
    const { ctx } = fakeContext({ services: { userQuestions: service } });
    hostAccessFromContext(ctx).questionHost!.registerProvider({ ask: askHost as never });
    expect(provider).toBeDefined();
    return (request) => provider!.ask(request);
  }

  it('maps the upstream request and restores selected labels plus custom text', async () => {
    let hostRequest: any;
    const ask = upstreamProvider(async (request) => {
      hostRequest = request;
      return {
        choice: ['option-1', 'typed answer'],
        free: 'free-form value',
      };
    });
    const controller = new AbortController();
    const result = await ask({
      agent: { session: { id: 'session-1' } },
      signal: controller.signal,
      questions: [
        {
          id: 'choice',
          question: 'Choose',
          detail: 'Longer context',
          header: 'Decision',
          multiSelect: true,
          intent: { kind: 'plan-review', approve: 'Same' },
          options: [
            { label: 'Same', description: 'first duplicate' },
            { label: 'Same', description: 'second duplicate' },
          ],
        },
        { id: 'free', question: 'Explain' },
      ],
    });

    expect(hostRequest).toEqual({
      sessionId: 'session-1',
      signal: controller.signal,
      items: [
        {
          id: 'choice',
          question: 'Choose',
          detail: 'Longer context',
          header: 'Decision',
          multiSelect: true,
          intent: { kind: 'plan-review', approve: 'Same' },
          options: [
            { id: 'option-0', label: 'Same', description: 'first duplicate' },
            { id: 'option-1', label: 'Same', description: 'second duplicate' },
          ],
        },
        { id: 'free', question: 'Explain', options: [] },
      ],
    });
    expect(result).toEqual({
      answers: [
        { id: 'choice', selected: ['Same'], custom: 'typed answer' },
        { id: 'free', selected: [], custom: 'free-form value' },
      ],
    });
  });

  it('rejects wire answers that cannot fit the upstream answer shape', async () => {
    const multiCustom = upstreamProvider(async () => ({ q: ['one', 'two'] }));
    await expect(
      multiCustom({ questions: [{ id: 'q', question: '?', multiSelect: true }] }),
    ).rejects.toThrowError(/more than one custom answer/);

    const arrayForSingle = upstreamProvider(async () => ({ q: ['option-0'] }));
    await expect(
      arrayForSingle({
        questions: [{ id: 'q', question: '?', options: [{ label: 'Yes' }] }],
      }),
    ).rejects.toThrowError(/multiple answers for single-select/);
  });
});

describe('hostAccessFromContext listCold wiring', () => {
  it('forwards the async persistence list (SessionHeader-shaped) to sessions.listCold', async () => {
    const persistence = {
      inspect: () => undefined,
      readFrom: () => [],
      // Upstream SessionPersistence.list(): Promise<SessionHeader[]> — headers
      // carry id/cwd/createdAt but no lastSeq.
      list: async () => [
        { id: 'cold-1', cwd: '/old', createdAt: 5, version: 0 },
        { id: 'cold-2', createdAt: 6, version: 0 },
      ],
    };
    const { ctx } = fakeContext({ services: { sessionPersistence: persistence } });
    const host = hostAccessFromContext(ctx);
    expect(host.persistenceHost).toBeDefined();
    await expect(host.sessions.listCold?.()).resolves.toEqual([
      { id: 'cold-1', cwd: '/old', createdAt: 5, version: 0 },
      { id: 'cold-2', createdAt: 6, version: 0 },
    ]);
  });

  it('leaves listCold and persistenceHost absent without a persistence service', () => {
    const { ctx } = fakeContext();
    const host = hostAccessFromContext(ctx);
    expect(host.persistenceHost).toBeUndefined();
    expect(host.sessions.listCold).toBeUndefined();
  });
});

describe('hostAccessFromContext optional-service probing', () => {
  it('probes every optional service through ctx.get (never plain property access)', () => {
    const { ctx, getCalls } = fakeContext({
      services: {
        userQuestions: { registerProvider: () => () => {} },
        llm: { listProviders: () => [], listModels: () => [] },
        compaction: { compactNow: async () => {} },
        attachments: { saveImage: async () => ({ id: 'a' }) },
      },
    });
    const host = hostAccessFromContext(ctx);
    expect(host.questionHost).toBeDefined();
    expect(host.catalogHost?.llm).toBeDefined();
    expect(host.catalogHost?.skills).toBeUndefined();
    expect(host.catalogHost?.agentPresets).toBeUndefined();
    expect(host.compactionHost).toBeDefined();
    expect(host.attachmentsHost).toBeDefined();
    for (const name of [
      'agentDefaultModel',
      'sessionPersistence',
      'userQuestions',
      'llm',
      'skills',
      'agentPresets',
      'compaction',
      'attachments',
    ]) {
      expect(getCalls).toContain(name);
    }
  });

  it('degrades to capabilities-off when the isolate makes ctx.get throw', () => {
    const { ctx } = fakeContext({ getThrows: true });
    const host = hostAccessFromContext(ctx);
    expect(host.persistenceHost).toBeUndefined();
    expect(host.questionHost).toBeUndefined();
    expect(host.catalogHost).toBeUndefined();
    expect(host.compactionHost).toBeUndefined();
    expect(host.attachmentsHost).toBeUndefined();
    // Required services still work (row-level inject guarantees them).
    expect(host.sessions.list()).toEqual([]);
  });
});
