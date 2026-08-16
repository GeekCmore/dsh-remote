/**
 * dsh-host smoke plugin. Mounted into a real `dsh` boot through the
 * composition tree (see smoke.patch.yml). Once `fs`, `subprocess` and
 * `remoteHub` are all available (service-availability-driven activation via
 * the `inject` below), it:
 *
 *   1. asserts ctx.fs / ctx.subprocess are OUR SSH providers (constructor
 *      names, not the dsh-local implementations),
 *   2. registers + connects the sshd container target on ctx.remoteHub,
 *   3. does a real ctx.fs.resolve + readText of the container fixture
 *      /home/dsh/work/hello.txt,
 *   4. spawns `echo` through ctx.subprocess and collects its stdout,
 *   5. prints one DSH_REMOTE_SMOKE OK line on stderr and exits 0.
 *
 * Any failure prints DSH_REMOTE_SMOKE FAIL plus the stack and exits 1.
 * Connection parameters come from the DSH_TEST_SSH_* environment exported by
 * integration/run-sshd.sh.
 */

const MARK_OK = 'DSH_REMOTE_SMOKE OK';
const MARK_FAIL = 'DSH_REMOTE_SMOKE FAIL';
const TARGET_ID = 'main';

function fail(error) {
  console.error(MARK_FAIL, error?.stack ?? String(error));
  process.exit(1);
}

export default function dshRemoteSmoke(ctx) {
  // Run detached from the plugin apply path: activation only guarantees the
  // services exist; the SSH connection and the assertions are async.
  (async () => {
    const env = process.env;
    for (const name of ['DSH_TEST_SSH_HOST', 'DSH_TEST_SSH_PORT', 'DSH_TEST_SSH_USER', 'DSH_TEST_SSH_KEY']) {
      if (!env[name]) throw new Error(`missing environment variable ${name} (run via e2e/dsh-host/run-smoke.sh)`);
    }

    const fsName = ctx.fs?.constructor?.name;
    const subprocessName = ctx.subprocess?.constructor?.name;
    const hubName = ctx.remoteHub?.constructor?.name;
    if (fsName !== 'SshFileSystem') throw new Error(`ctx.fs is ${String(fsName)}, expected SshFileSystem`);
    if (subprocessName !== 'SshSubprocessRuntime') {
      throw new Error(`ctx.subprocess is ${String(subprocessName)}, expected SshSubprocessRuntime`);
    }
    if (hubName !== 'SshRemoteHub') throw new Error(`ctx.remoteHub is ${String(hubName)}, expected SshRemoteHub`);

    ctx.remoteHub.addTarget({
      id: TARGET_ID,
      title: 'dsh-host smoke sshd container',
      ssh: {
        host: env.DSH_TEST_SSH_HOST,
        port: Number(env.DSH_TEST_SSH_PORT),
        username: env.DSH_TEST_SSH_USER,
        auth: { type: 'key', privateKeyPath: env.DSH_TEST_SSH_KEY },
        readyTimeoutMs: 15_000,
      },
    });
    await ctx.remoteHub.connect(TARGET_ID);

    const target = await ctx.fs.resolve('/home/dsh/work/hello.txt');
    const text = await ctx.fs.readText(target);
    if (!text.includes('hello remote')) {
      throw new Error(`unexpected fixture content: ${JSON.stringify(text)}`);
    }

    const handle = ctx.subprocess.spawn({
      argv: ['echo', 'dsh-remote-echo'],
      cwd: '/home/dsh/work',
      stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
      graceMs: 5_000,
    });
    const outcome = await handle.done;
    const echo = handle.collected.stdout?.readFrom(0).text ?? '';
    if (outcome.exitCode !== 0) throw new Error(`echo exited with ${String(outcome.exitCode)}`);
    if (echo.trim() !== 'dsh-remote-echo') throw new Error(`unexpected echo output: ${JSON.stringify(echo)}`);

    console.error(
      `${MARK_OK} fs=${fsName} subprocess=${subprocessName} hub=${hubName}`
        + ` hello=${JSON.stringify(text.trim())} echo=${JSON.stringify(echo.trim())}`,
    );
    process.exit(0);
  })().catch(fail);
}

// Activate only once all three services are mounted by the composition tree.
dshRemoteSmoke.inject = ['fs', 'subprocess', 'remoteHub'];
