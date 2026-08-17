/**
 * Wiring tests for index.ts's host narrowings (hostAccessFromContext):
 *
 * - session.create adapts the protocol's `{cwd, title}` onto upstream
 *   `SessionStore.create(undefined, {meta})` (title dropped; cwd may be
 *   absent → options omitted entirely);
 * - sessions.listCold is wired to the persistence index (upstream
 *   `SessionPersistence.list()` — async, SessionHeader-shaped);
 * - optional services are probed via `ctx.get(name, false)` (the isolate-safe
 *   soft access): absent services and a throwing get (the loader isolate's
 *   hard-isolation behavior) both degrade to "capability off".
 */
import { describe, expect, it } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { hostAccessFromContext } from '../src/index.js';
import type { HostSession } from '../src/host.js';

interface FakeUpstreamStore {
  createCalls: { id?: string; options?: { meta?: { cwd?: string } } }[];
  get(id: string): HostSession | undefined;
  list(): HostSession[];
  create(id?: string, options?: { meta?: { cwd?: string } }): HostSession;
  fork(source: string, boundary?: number): HostSession;
}

function fakeStore(): FakeUpstreamStore {
  const sessions = new Map<string, HostSession>();
  const calls: FakeUpstreamStore['createCalls'] = [];
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
    createCalls: calls,
    get: (id) => sessions.get(id),
    list: () => [...sessions.values()],
    create: (id, options) => {
      calls.push({ id, options });
      return mint(`session-${sessions.size + 1}`);
    },
    fork: (source) => mint(`${source}-fork`),
  };
}

/** Fake plugin context: property access for required services, ctx.get for probes. */
function fakeContext(
  options: {
    store?: FakeUpstreamStore;
    services?: Record<string, unknown>;
    getThrows?: boolean;
  } = {},
): { ctx: Context; store: FakeUpstreamStore; getCalls: string[] } {
  const store = options.store ?? fakeStore();
  const services = options.services ?? {};
  const getCalls: string[] = [];
  const ctx = {
    sessions: store,
    agents: { get: () => undefined },
    on: () => () => {},
    get: (name: string, _strict?: boolean) => {
      getCalls.push(name);
      if (options.getThrows) throw new Error(`isolate: service "${name}" not injected`);
      return services[name];
    },
  } as unknown as Context;
  return { ctx, store, getCalls };
}

describe('hostAccessFromContext session.create wiring', () => {
  it('adapts {cwd, title} to create(undefined, {meta: {cwd}}), dropping the title', () => {
    const { ctx, store } = fakeContext();
    const host = hostAccessFromContext(ctx);
    const session = host.sessions.create!({ cwd: '/home/dsh/work', title: 'ignored' });
    expect(session.id).toBe('session-1');
    expect(store.createCalls).toEqual([{ id: undefined, options: { meta: { cwd: '/home/dsh/work' } } }]);
    expect(host.sessions.list()).toHaveLength(1);
  });

  it('omits options entirely when no cwd is given', () => {
    const { ctx, store } = fakeContext();
    const host = hostAccessFromContext(ctx);
    host.sessions.create!({});
    expect(store.createCalls).toEqual([{ id: undefined, options: undefined }]);
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
