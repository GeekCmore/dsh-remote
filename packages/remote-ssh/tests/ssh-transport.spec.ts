import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeChannel, FakeClient, FakeSftp, sftpError } from './fake-ssh2.js';

vi.mock('ssh2', async () => {
  const fake = await import('./fake-ssh2.js');
  return { Client: fake.FakeClient };
});

import { SshTransport, type SshTargetConfig } from '../src/ssh-transport.js';
import { TransportError, type ExecProcess } from '@dsh-remote/remote';

const baseConfig: SshTargetConfig = {
  host: 'example.test',
  username: 'dsh',
  auth: { type: 'password', password: 'secret' },
};

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function connect(config: SshTargetConfig = baseConfig): Promise<SshTransport> {
  return SshTransport.connect(config);
}

beforeEach(() => {
  FakeClient.reset();
});

describe('SshTransport.connect', () => {
  it('maps auth/timeout/keepalive to ssh2 connect options', async () => {
    await connect({
      host: 'host.test',
      port: 2222,
      username: 'u',
      auth: { type: 'password', password: 'pw' },
      readyTimeoutMs: 5000,
      keepaliveIntervalMs: 1000,
    });
    expect(FakeClient.latest().connectOptionsAtCall).toMatchObject({
      host: 'host.test',
      port: 2222,
      username: 'u',
      password: 'pw',
      tryKeyboard: true,
      readyTimeout: 5000,
      keepaliveInterval: 1000,
    });
    expect(FakeClient.latest().connectOptions?.password).toBeUndefined();
  });

  it('defaults the port to 22 and uses the agent socket for agent auth', async () => {
    const old = process.env.SSH_AUTH_SOCK;
    process.env.SSH_AUTH_SOCK = '/tmp/agent.sock';
    try {
      await connect({ host: 'h', username: 'u', auth: { type: 'agent' } });
    } finally {
      if (old === undefined) delete process.env.SSH_AUTH_SOCK;
      else process.env.SSH_AUTH_SOCK = old;
    }
    expect(FakeClient.latest().connectOptions).toMatchObject({ port: 22, agent: '/tmp/agent.sock' });
  });

  it('answers keyboard-interactive prompts with the temporary password', async () => {
    FakeClient.deferReady = true;
    const pending = connect({ host: 'h', username: 'u', auth: { type: 'password', password: 'pw' } });
    const client = FakeClient.latest();
    await vi.waitFor(() => expect(client.listenerCount('keyboard-interactive')).toBe(1));
    let answers: string[] | undefined;
    client.emit(
      'keyboard-interactive',
      'login',
      '',
      '',
      [{ prompt: 'Password: ', echo: false }],
      (value: string[]) => { answers = value; },
    );
    expect(answers).toEqual(['pw']);
    client.ready();
    await pending;
    expect(client.listenerCount('keyboard-interactive')).toBe(0);
  });

  it('reads the private key file for key auth', async () => {
    await connect({ host: 'h', username: 'u', auth: { type: 'key', privateKeyPath: '/dev/null', passphrase: 'p' } });
    const options = FakeClient.latest().connectOptions!;
    expect(options.privateKey).toBeInstanceOf(Buffer);
    expect(options.passphrase).toBe('p');
  });

  it('rejects with TransportError on handshake failure', async () => {
    FakeClient.nextConnectError = new Error('timed out');
    const err = await connect().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect((err as TransportError).code).toBe('IO_ERROR');
    expect((err as Error).message).toContain('example.test:22');
  });

  it('invokes the hostVerifier hook with a SHA-256 fingerprint and raw key', async () => {
    const seen: Array<[string, Buffer]> = [];
    const key = Buffer.from('host-key');
    await SshTransport.connect(baseConfig, {
      hostVerifier: (fingerprint, hostKey) => {
        seen.push([fingerprint, hostKey]);
        return true;
      },
    });
    // The fake client does not exercise the verifier during its handshake;
    // drive it directly to check the fingerprint/key plumbing.
    const verifier = FakeClient.latest().connectOptions!.hostVerifier as (
      key: Buffer,
      done: (valid: boolean) => void,
    ) => void;
    let result: boolean | undefined;
    verifier(key, (valid) => {
      result = valid;
    });
    await vi.waitFor(() => expect(result).toBe(true));
    expect(seen).toHaveLength(1);
    expect(seen[0]![1]).toEqual(key);
    expect(seen[0]![0]).toMatch(/^[A-Za-z0-9+/]+$/);
  });
});

describe('SshTransport.exec', () => {
  it('streams stdout/stderr and resolves done with the exit code', async () => {
    const transport = await connect();
    FakeClient.latest().execHandler = () => ({
      stdout: ['hello ', 'world'],
      stderr: ['oops'],
      code: 3,
    });
    const proc = await transport.exec('whatever');
    const [out, errOut, done] = await Promise.all([collect(proc.stdout), collect(proc.stderr), proc.done]);
    expect(out.toString()).toBe('hello world');
    expect(errOut.toString()).toBe('oops');
    expect(done).toEqual({ code: 3 });
  });

  it('never rejects done on non-zero exit', async () => {
    const transport = await connect();
    FakeClient.latest().execHandler = () => ({ code: 127 });
    const proc = await transport.exec('missing-command');
    await expect(proc.done).resolves.toEqual({ code: 127 });
  });

  it('requests a PTY when opts.pty is set', async () => {
    const transport = await connect();
    const seen: Array<Record<string, unknown>> = [];
    FakeClient.latest().execHandler = (_command, opts) => {
      seen.push(opts);
      return { code: 0 };
    };
    await transport.exec('cmd', { pty: true });
    expect(seen[0]).toMatchObject({ pty: true });
  });

  it('maps a PtySpec to the ssh2 pty-req window size and TERM', async () => {
    const transport = await connect();
    const seen: Array<Record<string, unknown>> = [];
    FakeClient.latest().execHandler = (_command, opts) => {
      seen.push(opts);
      return { code: 0 };
    };
    await transport.exec('cmd', { pty: { rows: 24, cols: 80, term: 'xterm-kitty' } });
    expect(seen[0]).toMatchObject({ pty: { rows: 24, cols: 80, term: 'xterm-kitty' } });
    await transport.exec('cmd', { pty: { rows: 40, cols: 120 } });
    expect(seen[1]).toMatchObject({ pty: { rows: 40, cols: 120, term: 'xterm-256color' } });
  });

  it('layers cwd and env onto the shell command line with quoting', async () => {
    const transport = await connect();
    const commands: string[] = [];
    FakeClient.latest().execHandler = (command) => {
      commands.push(command);
      return { code: 0 };
    };
    await transport.exec("echo 'x'", { cwd: "/tmp/a'b", env: { FOO: "v'1", BAR: '2' } });
    expect(commands[0]).toBe(`cd '/tmp/a'\\''b' && FOO='v'\\''1' BAR='2' echo 'x'`);
  });

  it('captures stdin writes and endStdin', async () => {
    const transport = await connect();
    FakeClient.latest().execHandler = () => ({ manual: true });
    const proc = await transport.exec('cat');
    proc.write(new Uint8Array([65]));
    proc.write('bc');
    proc.endStdin();
    const channel = lastChannel();
    expect(Buffer.concat(channel.written).toString()).toBe('Abc');
    expect(channel.stdinEnded).toBe(true);
    await proc.kill();
    await expect(proc.done).resolves.toEqual({ code: null });
  });

  it('kill() closes the channel and settles done', async () => {
    const transport = await connect();
    FakeClient.latest().execHandler = () => ({ manual: true });
    const proc = await transport.exec('sleep 100');
    await proc.kill();
    expect(lastChannel().destroyed).toBe(true);
    await expect(proc.done).resolves.toEqual({ code: null });
  });

  it('aborts via opts.signal', async () => {
    const transport = await connect();
    FakeClient.latest().execHandler = () => ({ manual: true });
    const controller = new AbortController();
    const proc = await transport.exec('sleep 100', { signal: controller.signal });
    controller.abort();
    await expect(proc.done).resolves.toEqual({ code: null });
    expect(lastChannel().destroyed).toBe(true);
  });

  it('rejects with IO_ERROR when the channel cannot be opened', async () => {
    const transport = await connect();
    FakeClient.latest().execHandler = () => ({ error: new Error('administratively prohibited') });
    const err = await transport.exec('x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect((err as TransportError).code).toBe('IO_ERROR');
  });
});

/** Latest exec channel opened on the current fake client. */
function lastChannel(): FakeChannel {
  const channel = FakeClient.latest().channels.at(-1);
  if (!channel) throw new Error('no channel created yet');
  return channel;
}

describe('SshTransport.sftp', () => {
  async function setup(): Promise<{ transport: SshTransport; sftp: FakeSftp }> {
    const transport = await connect();
    const client = FakeClient.latest();
    const fake = new FakeSftp();
    client.sftpImpl = fake;
    return { transport, sftp: fake };
  }

  it('performs CRUD operations over the subsystem', async () => {
    const { transport, sftp } = await setup();
    const api = await transport.sftp();
    await api.mkdir('/data', 0o700);
    expect(sftp.dirs.has('/data')).toBe(true);

    const writer = api.createWriteStream('/data/a.txt', 0o600);
    writer.write(new Uint8Array([104, 105]));
    writer.write('!');
    await writer.end();
    expect(sftp.files.get('/data/a.txt')?.toString()).toBe('hi!');

    const stat = await api.stat('/data/a.txt');
    expect(stat.size).toBe(3);
    expect(stat.isFile()).toBe(true);
    expect(stat.isDirectory()).toBe(false);

    const dirStat = await api.lstat('/data');
    expect(dirStat.isDirectory()).toBe(true);

    const entries = await api.readdir('/data');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe('a.txt');

    const reader = api.createReadStream('/data/a.txt');
    expect((await collect(reader)).toString()).toBe('hi!');

    await api.rename('/data/a.txt', '/data/b.txt');
    expect(sftp.files.has('/data/b.txt')).toBe(true);

    await api.unlink('/data/b.txt');
    expect(sftp.files.has('/data/b.txt')).toBe(false);

    await api.rmdir('/data');
    expect(sftp.dirs.has('/data')).toBe(false);
  });

  it('caches the subsystem handle', async () => {
    const { transport } = await setup();
    expect(await transport.sftp()).toBe(await transport.sftp());
  });

  it('maps status code 2 to NO_SUCH_FILE', async () => {
    const { transport } = await setup();
    const api = await transport.sftp();
    const err = await api.stat('/missing').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect((err as TransportError).code).toBe('NO_SUCH_FILE');
  });

  it('maps status code 3 to PERMISSION_DENIED', async () => {
    const { transport, sftp } = await setup();
    sftp.fail.set('unlink', sftpError(3, 'Permission denied'));
    const api = await transport.sftp();
    const err = await api.unlink('/root/file').catch((e: unknown) => e);
    expect((err as TransportError).code).toBe('PERMISSION_DENIED');
  });

  it('maps other failures to IO_ERROR', async () => {
    const { transport, sftp } = await setup();
    sftp.fail.set('mkdir', sftpError(4, 'Failure'));
    const api = await transport.sftp();
    const err = await api.mkdir('/x').catch((e: unknown) => e);
    expect((err as TransportError).code).toBe('IO_ERROR');
  });

  it('rejects sftp() itself when the subsystem cannot be opened', async () => {
    const transport = await connect();
    FakeClient.latest().sftpError = new Error('subsystem request failed');
    const err = await transport.sftp().catch((e: unknown) => e);
    expect((err as TransportError).code).toBe('IO_ERROR');
  });
});

describe('SshTransport.probeLoginEnv', () => {
  it('parses NUL-framed values', async () => {
    const transport = await connect();
    FakeClient.latest().execHandler = () => ({ stdout: [Buffer.from('/home/dsh\0/usr/bin\0')] });
    const env = await transport.probeLoginEnv(['HOME', 'PATH']);
    expect(env).toEqual({ HOME: '/home/dsh', PATH: '/usr/bin' });
  });

  it('builds a read-only printf probe', async () => {
    const transport = await connect();
    const commands: string[] = [];
    FakeClient.latest().execHandler = (command) => {
      commands.push(command);
      return { stdout: ['\0'] };
    };
    await transport.probeLoginEnv(['HOME']);
    expect(commands[0]).toBe(`printf '%s\\0' "$HOME"`);
  });

  it('degrades to an empty object on failure instead of throwing', async () => {
    const transport = await connect();
    FakeClient.latest().execHandler = () => ({ error: new Error('boom') });
    await expect(transport.probeLoginEnv(['HOME'])).resolves.toEqual({});
  });

  it('degrades to an empty object on non-zero exit', async () => {
    const transport = await connect();
    FakeClient.latest().execHandler = () => ({ code: 1, stdout: [''] });
    await expect(transport.probeLoginEnv(['HOME'])).resolves.toEqual({});
  });

  it('rejects invalid variable names', async () => {
    const transport = await connect();
    await expect(transport.probeLoginEnv(['FOO;rm -rf /'])).rejects.toThrow(TypeError);
  });
});

describe('SshTransport lifecycle', () => {
  it('close() is idempotent and ends the client', async () => {
    const transport = await connect();
    await transport.close();
    await transport.close();
    expect(FakeClient.latest().ended).toBe(true);
    const err = await transport.exec('x').catch((e: unknown) => e);
    expect((err as TransportError).code).toBe('CONN_LOST');
  });

  it('fires onUnexpectedClose and fails operations with CONN_LOST after a drop', async () => {
    const transport = await connect();
    const calls: Array<Error | undefined> = [];
    transport.onUnexpectedClose = (err) => calls.push(err);
    FakeClient.latest().drop(new Error('connection reset'));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.message).toBe('connection reset');

    const execErr = await transport.exec('x').catch((e: unknown) => e);
    expect((execErr as TransportError).code).toBe('CONN_LOST');
    const sftpErr = await transport.sftp().catch((e: unknown) => e);
    expect((sftpErr as TransportError).code).toBe('CONN_LOST');
  });

  it('does not fire onUnexpectedClose for an intentional close', async () => {
    const transport = await connect();
    const spy = vi.fn();
    transport.onUnexpectedClose = spy;
    await transport.close();
    expect(spy).not.toHaveBeenCalled();
  });

  it('fails SFTP operations obtained before the drop with CONN_LOST', async () => {
    const transport = await connect();
    const api = await transport.sftp();
    FakeClient.latest().drop();
    const err = await api.stat('/x').catch((e: unknown) => e);
    expect((err as TransportError).code).toBe('CONN_LOST');
    expect(() => api.createReadStream('/x')).toThrowError(TransportError);
  });

  it('kill() still resolves after the connection drops mid-exec', async () => {
    const transport = await connect();
    FakeClient.latest().execHandler = () => ({ manual: true });
    const proc: ExecProcess = await transport.exec('sleep 100');
    FakeClient.latest().drop();
    await expect(proc.kill()).resolves.toBeUndefined();
  });
});
