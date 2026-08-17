import { afterEach, describe, expect, it } from 'vitest';
import { setupProxy, teardownProxy, type ProxySetup } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function track(setup: ProxySetup): ProxySetup {
  cleanups.push(() => teardownProxy(setup));
  return setup;
}

describe('remote catalog facades', () => {
  it('maps daemon models, skills and presets onto the local read services', async () => {
    const setup = track(await setupProxy());
    await setup.proxy.catalogs.ready;

    expect(setup.proxy.catalogs.llm.listProviders()).toEqual([
      { id: 'fake-provider', name: 'fake-provider' },
    ]);
    await expect(setup.proxy.catalogs.llm.listModels('fake-provider')).resolves.toEqual([
      { provider: 'fake-provider', id: 'fake-model-1', name: 'Fake Model 1' },
      { provider: 'fake-provider', id: 'fake-model-2', name: 'fake-model-2' },
    ]);
    await expect(setup.proxy.catalogs.skills.list()).resolves.toEqual([
      { name: 'fake-skill', description: 'A fake skill' },
    ]);
    await expect(setup.proxy.catalogs.agentPresets.list()).resolves.toEqual([
      { id: 'fake-preset', name: 'Fake Preset' },
    ]);
    expect(setup.proxy.catalogs.agentPresets.defaultId).toBe('fake-preset');
  });

  it('does not fall back to local rows when the backend lacks catalog capability', async () => {
    const setup = track(await setupProxy({ capabilities: [] }));
    await setup.proxy.catalogs.ready;
    expect(setup.proxy.catalogs.llm.listProviders()).toEqual([]);
    await expect(setup.proxy.catalogs.skills.list()).rejects.toMatchObject({
      code: 'REMOTE_CAPABILITY_UNSUPPORTED',
    });
  });
});
