import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { SshFileSystem } from '@dsh-remote/fs-ssh';
import { RemoteTransfer } from '../src/transfer.js';
import { registerRemoteCopyTool, remoteCopyDefinition } from '../src/tool-copy.js';
import type { ToolDefinitionAccess, ToolRegistryAccess } from '../src/tool-copy.js';
import remoteFrontend from '../src/index.js';
import { FakeTransport } from './fake-transport.js';

class FakeTools implements ToolRegistryAccess {
  readonly registered: ToolDefinitionAccess[] = [];

  register(definition: ToolDefinitionAccess): () => void {
    this.registered.push(definition);
    return () => {
      const i = this.registered.indexOf(definition);
      if (i >= 0) this.registered.splice(i, 1);
    };
  }
}

function setup() {
  const ctx = new Context();
  const fake = new FakeTransport();
  const fs = new SshFileSystem(ctx, { getTransport: () => fake });
  const transfer = new RemoteTransfer(ctx, {
    getRemoteFs: () => fs,
    getTransport: () => fake,
  });
  return { ctx, fake, fs, transfer };
}

describe('remote_copy definition', () => {
  it('declares the documented schema and canonical string output', () => {
    const { transfer } = setup();
    const def = remoteCopyDefinition(transfer);
    expect(def.name).toBe('remote_copy');
    const params = def.parameters as Record<string, Record<string, unknown>>;
    for (const name of ['targetId', 'direction', 'remotePath', 'localPath']) {
      expect(params[name]).toMatchObject({ type: 'string', required: true });
    }
    expect(params['direction']!['enum']).toEqual(['download', 'upload']);
    expect(params['overwrite']).toMatchObject({ type: 'boolean' });
    expect(def.output.schema).toEqual({ type: 'string' });
    expect(def.output.render({}, 'ok')).toEqual([{ type: 'text', text: 'ok' }]);
  });

  it('executes a download through RemoteTransfer and returns a summary', async () => {
    const { fake, transfer } = setup();
    const dir = await mkdtemp(join(tmpdir(), 'dsh-rf-tool-'));
    fake.mkdir('/work');
    fake.writeFile('/work/a.txt', 'hello');
    const def = remoteCopyDefinition(transfer);
    const dest = join(dir, 'a.txt');
    const out = await def.execute(
      {
        targetId: 't1',
        direction: 'download',
        remotePath: '/work/a.txt',
        localPath: dest,
      } as never,
      { signal: new AbortController().signal },
    );
    expect(out).toMatch(
      new RegExp(`^copied 5 bytes from /work/a\\.txt to ${dest.replace(/[/.]/g, '\\$&')} in \\d+ms \\(download\\)$`),
    );
    expect(await readFile(dest, 'utf8')).toBe('hello');
  });

  it('executes an upload and surfaces transfer errors', async () => {
    const { fake, transfer } = setup();
    const dir = await mkdtemp(join(tmpdir(), 'dsh-rf-tool-'));
    fake.mkdir('/work');
    const src = join(dir, 'u.txt');
    await writeFile(src, 'up');
    const def = remoteCopyDefinition(transfer);
    const out = await def.execute(
      { targetId: 't1', direction: 'upload', remotePath: '/work/u.txt', localPath: src } as never,
      { signal: new AbortController().signal },
    );
    expect(out).toContain('copied 2 bytes');
    expect(new TextDecoder().decode(fake.readFile('/work/u.txt'))).toBe('up');
    // Second call without overwrite fails out of the tool body.
    await expect(
      def.execute(
        { targetId: 't1', direction: 'upload', remotePath: '/work/u.txt', localPath: src } as never,
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' });
  });
});

describe('registerRemoteCopyTool', () => {
  it('registers on ctx.tools when the registry is present and returns a disposer', () => {
    const { ctx, transfer } = setup();
    const tools = new FakeTools();
    (ctx as unknown as { tools?: ToolRegistryAccess }).tools = tools;
    const dispose = registerRemoteCopyTool(ctx, transfer);
    expect(dispose).toBeTypeOf('function');
    expect(tools.registered.map((d) => d.name)).toEqual(['remote_copy']);
    dispose!();
    expect(tools.registered).toEqual([]);
  });

  it('is a silent no-op when ctx.tools is absent', () => {
    const { ctx, transfer } = setup();
    expect(registerRemoteCopyTool(ctx, transfer)).toBeUndefined();
  });
});

describe('default plugin', () => {
  it('registers remoteTransfer and remoteMonitor and skips the tool without ctx.tools', async () => {
    const ctx = new Context();
    const fake = new FakeTransport();
    await remoteFrontend(ctx, {
      getRemoteFs: () => undefined,
      getTransport: () => fake,
    });
    expect(ctx.remoteTransfer).toBeInstanceOf(RemoteTransfer);
    expect(ctx.remoteMonitor).toBeDefined();
  });

  it('attaches remote_copy when ctx.tools is present', async () => {
    const ctx = new Context();
    const fake = new FakeTransport();
    const tools = new FakeTools();
    (ctx as unknown as { tools?: ToolRegistryAccess }).tools = tools;
    await remoteFrontend(ctx, {
      getRemoteFs: () => undefined,
      getTransport: () => fake,
    });
    expect(tools.registered.map((d) => d.name)).toEqual(['remote_copy']);
  });
});
