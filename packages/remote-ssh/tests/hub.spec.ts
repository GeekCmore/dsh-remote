import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { FakeClient } from './fake-ssh2.js';

vi.mock('ssh2', async () => {
  const fake = await import('./fake-ssh2.js');
  return { Client: fake.FakeClient };
});

import type { RemoteTarget } from '@dsh-remote/remote';
import { SshRemoteHub } from '../src/hub-ssh.js';
import Plugin from '../src/index.js';

const ssh: RemoteTarget['ssh'] = {
  host: 'example.test',
  username: 'dsh',
  auth: { type: 'password', password: 'secret' },
};

describe('SshRemoteHub', () => {
  let ctx: Context;
  let hub: SshRemoteHub;
  let fiber: { dispose(): Promise<void> };

  beforeEach(async () => {
    FakeClient.reset();
    // Answer the runtime-root probe (`mkdir -p … && chmod 700 … && pwd -P`)
    // with a resolved absolute path.
    FakeClient.defaultExec = (command) =>
      command.includes('mkdir')
        ? { stdout: ['/home/dsh/.cache/dsh-remote/0123456789abcdef\n'] }
        : { code: 0 };
    ctx = new Context();
    fiber = await ctx.plugin(Plugin);
    hub = ctx.remoteHub as SshRemoteHub;
  });

  describe('target registry', () => {
    it('adds, gets, lists and removes targets', async () => {
      const id = hub.addTarget({ id: 'prod', title: 'Prod box', ssh });
      expect(id).toBe('prod');
      expect(hub.getTarget('prod')).toMatchObject({ title: 'Prod box', ssh });
      expect(hub.listTargets()).toEqual([{ id: 'prod', title: 'Prod box', status: 'disconnected' }]);
      await hub.removeTarget('prod');
      expect(hub.getTarget('prod')).toBeUndefined();
      expect(hub.listTargets()).toEqual([]);
    });

    it('generates an id when omitted', () => {
      const id = hub.addTarget({ ssh });
      expect(id).toMatch(/^[0-9a-f]{8}$/);
      expect(hub.getTarget(id)?.id).toBe(id);
    });

    it('rejects duplicate ids', () => {
      hub.addTarget({ id: 'dup', ssh });
      expect(() => hub.addTarget({ id: 'dup', ssh })).toThrow(/duplicate/);
    });

    it('keeps the pairingTokenRef placeholder on the registration', () => {
      hub.addTarget({ id: 't', ssh, pairingTokenRef: 'keyring:dsh-remote/t' });
      expect(hub.getTarget('t')?.pairingTokenRef).toBe('keyring:dsh-remote/t');
    });
  });

  describe('connect', () => {
    it('throws for unknown targets', () => {
      expect(() => hub.connect('nope')).toThrow(/unknown remote target/);
    });

    it('connects, creates the runtime root, and emits remote/connected', async () => {
      hub.addTarget({ id: 'a', ssh });
      const connected = vi.fn();
      ctx.on('remote/connected', connected);

      const transport = await hub.connect('a');
      // connect succeeded only after the runtime-root exec ran
      const client = FakeClient.latest();
      const root = hub.runtimeRoot('a');
      expect(root).toMatch(/^\//);
      expect(client.channels.length).toBeGreaterThan(0);
      expect(hub.status('a')).toBe('connected');
      expect(hub.get('a')).toBe(transport);
      expect(connected).toHaveBeenCalledWith('a');
    });

    it('reuses the live transport for repeated connects', async () => {
      hub.addTarget({ id: 'a', ssh });
      const first = await hub.connect('a');
      const second = await hub.connect('a');
      expect(second).toBe(first);
      expect(FakeClient.instances).toHaveLength(1);
    });

    it('dedupes concurrent connects to one promise', async () => {
      hub.addTarget({ id: 'a', ssh });
      const [first, second] = await Promise.all([hub.connect('a'), hub.connect('a')]);
      expect(second).toBe(first);
      expect(FakeClient.instances).toHaveLength(1);
    });

    it('reports connecting status while the attempt is in flight', async () => {
      hub.addTarget({ id: 'a', ssh });
      const pending = hub.connect('a');
      expect(hub.status('a')).toBe('connecting');
      await pending;
      expect(hub.status('a')).toBe('connected');
    });

    it('fails the connection and cleans up when runtime-root setup fails', async () => {
      hub.addTarget({ id: 'a', ssh });
      const created = hub.connect('a');
      FakeClient.latest().execHandler = () => ({ code: 1, stderr: ['mkdir: permission denied'] });
      const err = await created.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(hub.status('a')).toBe('disconnected');
      expect(hub.get('a')).toBeUndefined();
      expect(hub.runtimeRoot('a')).toBeUndefined();
      expect(FakeClient.latest().ended).toBe(true);
    });

    it('fails the connection when the handshake fails', async () => {
      hub.addTarget({ id: 'a', ssh });
      FakeClient.nextConnectError = new Error('auth failed');
      const err = await hub.connect('a').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(hub.status('a')).toBe('disconnected');
    });
  });

  describe('status machine and events', () => {
    it('emits remote/degraded on unexpected drop', async () => {
      hub.addTarget({ id: 'a', ssh });
      await hub.connect('a');
      const degraded = vi.fn();
      ctx.on('remote/degraded', degraded);

      FakeClient.latest().drop(new Error('reset'));
      expect(degraded).toHaveBeenCalledWith('a');
      expect(hub.status('a')).toBe('degraded');
      expect(hub.get('a')).toBeUndefined();
    });

    it('reconnects a degraded target with a fresh transport', async () => {
      hub.addTarget({ id: 'a', ssh });
      const first = await hub.connect('a');
      FakeClient.latest().drop();
      expect(hub.status('a')).toBe('degraded');
      const second = await hub.connect('a');
      expect(second).not.toBe(first);
      expect(hub.status('a')).toBe('connected');
    });

    it('disconnect() closes the transport and emits remote/disconnected', async () => {
      hub.addTarget({ id: 'a', ssh });
      await hub.connect('a');
      const disconnected = vi.fn();
      ctx.on('remote/disconnected', disconnected);

      await hub.disconnect('a');
      expect(FakeClient.latest().ended).toBe(true);
      expect(hub.status('a')).toBe('disconnected');
      expect(hub.get('a')).toBeUndefined();
      expect(hub.runtimeRoot('a')).toBeUndefined();
      expect(disconnected).toHaveBeenCalledWith('a');
    });

    it('disconnect() is a no-op for unknown or idle targets', async () => {
      const disconnected = vi.fn();
      ctx.on('remote/disconnected', disconnected);
      await hub.disconnect('ghost');
      hub.addTarget({ id: 'idle', ssh });
      await hub.disconnect('idle');
      expect(disconnected).not.toHaveBeenCalled();
    });

    it('does not emit degraded when disconnecting intentionally', async () => {
      hub.addTarget({ id: 'a', ssh });
      await hub.connect('a');
      const degraded = vi.fn();
      ctx.on('remote/degraded', degraded);
      await hub.disconnect('a');
      expect(degraded).not.toHaveBeenCalled();
    });
  });

  describe('declarative config', () => {
    it('registers config.targets at startup', async () => {
      const local = new Context();
      const localFiber = await local.plugin(SshRemoteHub, { targets: [{ id: 'cfg', title: 'From config', ssh }] });
      const configured = local.remoteHub as SshRemoteHub;
      expect(configured.getTarget('cfg')).toMatchObject({ id: 'cfg', title: 'From config', ssh });
      expect(configured.listTargets()).toEqual([{ id: 'cfg', title: 'From config', status: 'disconnected' }]);
      await localFiber.dispose();
    });

    it('autoConnect connects declared targets on activation', async () => {
      const local = new Context();
      const localFiber = await local.plugin(SshRemoteHub, { targets: [{ id: 'cfg', ssh }], autoConnect: true });
      const configured = local.remoteHub as SshRemoteHub;
      await vi.waitFor(() => expect(configured.status('cfg')).toBe('connected'));
      expect(configured.get('cfg')).toBeDefined();
      expect(configured.runtimeRoot('cfg')).toMatch(/^\//);
      await localFiber.dispose();
    });

    it('autoConnect failure leaves the target disconnected without failing startup', async () => {
      FakeClient.nextConnectError = new Error('auth failed');
      const local = new Context();
      const localFiber = await local.plugin(SshRemoteHub, { targets: [{ id: 'cfg', ssh }], autoConnect: true });
      const configured = local.remoteHub as SshRemoteHub;
      await vi.waitFor(() => expect(configured.status('cfg')).toBe('disconnected'));
      await localFiber.dispose();
    });
  });

  describe('disposal', () => {
    it('closes every connection when the plugin unloads', async () => {
      hub.addTarget({ id: 'a', ssh });
      hub.addTarget({ id: 'b', ssh });
      await hub.connect('a');
      await hub.connect('b');
      const clients = [...FakeClient.instances];
      await fiber.dispose();
      expect(clients.every((client) => client.ended)).toBe(true);
      expect(hub.status('a')).toBe('disconnected');
      expect(hub.status('b')).toBe('disconnected');
    });
  });
});
