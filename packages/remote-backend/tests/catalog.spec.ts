import { describe, expect, it } from 'vitest';
import { Methods, type CatalogListResult } from '@dsh-remote/core';
import { FakeCatalogs, expectRemoteError, handshake, makeWorld } from './fakes.js';

describe('catalog.list', () => {
  it('lists models grouped by provider', async () => {
    const world = makeWorld({ catalogs: new FakeCatalogs() });
    await handshake(world.client);
    const res = (await world.client.call(Methods.CatalogList, { kind: 'models' })) as CatalogListResult;
    expect(res.kind).toBe('models');
    if (res.kind !== 'models') throw new Error('unreachable');
    expect(res.providers.map((p) => p.provider)).toEqual(['anthropic', 'openai-compatible']);
    expect(res.providers[0]!.models[0]).toEqual({
      id: 'claude-x',
      name: 'Claude X',
      current: true,
      routable: true,
    });
    expect(res.providers[1]!.models[0]).toEqual({
      id: 'gpt-y',
      reasoningEfforts: ['low', 'high'],
    });
  });

  it('awaits the real upstream async catalog methods', async () => {
    const world = makeWorld({
      catalogs: new FakeCatalogs({
        llm: {
          listProviders: async () => [{ id: 'async-provider' }],
          listModels: async () => [{ id: 'async-model', name: 'Async Model' }],
        },
        skills: { list: async () => [{ name: 'async-skill' }] },
        agentPresets: {
          defaultId: 'async-preset',
          list: async () => [{ id: 'async-preset' }],
        },
      }),
    });
    await handshake(world.client);
    await expect(world.client.call(Methods.CatalogList, { kind: 'models' })).resolves.toEqual({
      kind: 'models',
      providers: [
        {
          provider: 'async-provider',
          models: [{ id: 'async-model', name: 'Async Model' }],
        },
      ],
    });
    await expect(world.client.call(Methods.CatalogList, { kind: 'skills' })).resolves.toEqual({
      kind: 'skills',
      skills: [{ name: 'async-skill' }],
    });
    await expect(
      world.client.call(Methods.CatalogList, { kind: 'agentPresets' }),
    ).resolves.toEqual({
      kind: 'agentPresets',
      agentPresets: [{ id: 'async-preset', name: 'async-preset', isDefault: true }],
    });
  });

  it('lists skills and agent presets', async () => {
    const world = makeWorld({ catalogs: new FakeCatalogs() });
    await handshake(world.client);
    const skills = (await world.client.call(Methods.CatalogList, { kind: 'skills' })) as CatalogListResult;
    expect(skills).toEqual({
      kind: 'skills',
      skills: [{ name: 'review', description: 'Code review' }],
    });
    const presets = (await world.client.call(Methods.CatalogList, {
      kind: 'agentPresets',
    })) as CatalogListResult;
    expect(presets).toEqual({
      kind: 'agentPresets',
      agentPresets: [{ id: 'default', name: 'Default', isDefault: true }],
    });
  });

  it('reports a missing catalog kind as REMOTE_CAPABILITY_UNSUPPORTED', async () => {
    const catalogs = new FakeCatalogs({ skills: undefined, agentPresets: undefined });
    // Simulate a host with only the models catalog.
    catalogs.skills = undefined;
    catalogs.agentPresets = undefined;
    const world = makeWorld({ catalogs });
    await handshake(world.client);
    await expectRemoteError(
      world.client.call(Methods.CatalogList, { kind: 'skills' }),
      'REMOTE_CAPABILITY_UNSUPPORTED',
    );
  });

  it('fails REMOTE_CAPABILITY_UNSUPPORTED with no catalog host at all', async () => {
    const world = makeWorld();
    await handshake(world.client);
    await expectRemoteError(
      world.client.call(Methods.CatalogList, { kind: 'models' }),
      'REMOTE_CAPABILITY_UNSUPPORTED',
    );
  });

  it('rejects an unknown catalog kind', async () => {
    const world = makeWorld({ catalogs: new FakeCatalogs() });
    await handshake(world.client);
    await expectRemoteError(
      world.client.call(Methods.CatalogList, { kind: 'bogus' }),
      'REMOTE_PROTOCOL_ERROR',
    );
  });
});
