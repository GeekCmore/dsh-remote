/**
 * dsh-daemon smoke plugin. Mounted into a real `dsh` boot through the
 * composition tree (see smoke.patch.yml — a key-auth adaptation of the
 * @dsh-remote/bundle-daemon-tui rows). Once `sessions`, `agents`,
 * `sessionPersistence`, `remoteHub` and `remoteSessions` are all available
 * (service-availability-driven activation via the `inject` below), it:
 *
 *   1. asserts ctx.sessions / ctx.agents / ctx.sessionPersistence are the
 *      REMOTE-PROXY implementations (constructor names — RemoteSessionStore,
 *      the real upstream AgentRegistry mounted by the proxy,
 *      RemoteSessionPersistence), not the dsh-local ones,
 *   2. waits for ctx.remoteSessions to connect (the first list() call opens
 *      the SSH exec channel and runs the pairing handshake),
 *   3. creates a session through ctx.agents.create() — the upstream creation
 *      contract, routed by the proxy's RemoteAgentFactory to
 *      client.create() on the remote daemon (the sync ctx.sessions.create()
 *      must refuse with the documented async-path guidance),
 *   4. asserts the remote list (live + cold) shows the session, reads its
 *      history through a read-mode attach, and forks it at a seq boundary
 *      via the handle's fork API — asserting the forked child shows up in
 *      the remote (cold) listing,
 *   5. prints one DSH_REMOTE_DAEMON_SMOKE OK line on stderr and exits 0.
 *
 * Any failure prints DSH_REMOTE_DAEMON_SMOKE FAIL plus the stack and exits 1.
 * The SSH target and pairing token come from smoke.patch.yml
 * (DSH_TEST_SSH_* / DSH_REMOTE_TOKEN environment).
 */

const MARK_OK = 'DSH_REMOTE_DAEMON_SMOKE OK';
const MARK_FAIL = 'DSH_REMOTE_DAEMON_SMOKE FAIL';
// The remote-ssh target id declared in smoke.patch.yml (and referenced by the
// remote-proxy row's targetId).
const TARGET_ID = 'default';

function fail(error) {
  console.error(MARK_FAIL, error?.stack ?? String(error));
  process.exit(1);
}

export default function dshRemoteDaemonSmoke(ctx) {
  // Run detached from the plugin apply path: activation only guarantees the
  // services exist; the SSH connection and the assertions are async.
  (async () => {
    // --- 1. the seam swap happened -----------------------------------------
    const sessionsName = ctx.sessions?.constructor?.name;
    const agentsName = ctx.agents?.constructor?.name;
    const persistenceName = ctx.sessionPersistence?.constructor?.name;
    const remoteSessionsName = ctx.remoteSessions?.constructor?.name;
    if (sessionsName !== 'RemoteSessionStore') {
      throw new Error(`ctx.sessions is ${String(sessionsName)}, expected RemoteSessionStore`);
    }
    // ctx.agents is the REAL upstream AgentRegistry mounted by remote-proxy
    // (the dsh-base `agent` row is disabled by the patch, so its presence
    // here is the proxy's); its RemoteAgentFactory routes create/resume to
    // the daemon — asserted behaviorally in step 3 below.
    if (agentsName !== 'AgentRegistry') {
      throw new Error(`ctx.agents is ${String(agentsName)}, expected AgentRegistry`);
    }
    if (persistenceName !== 'RemoteSessionPersistence') {
      throw new Error(`ctx.sessionPersistence is ${String(persistenceName)}, expected RemoteSessionPersistence`);
    }
    if (remoteSessionsName !== 'DaemonRemoteSessions') {
      throw new Error(`ctx.remoteSessions is ${String(remoteSessionsName)}, expected DaemonRemoteSessions`);
    }

    // Documented degradation: the sync sessions.create() cannot mint a remote
    // session; it must throw guidance towards ctx.agents.create().
    let guided = false;
    try {
      ctx.sessions.create();
    } catch (err) {
      guided = /agents\.create/.test(String(err));
    }
    if (!guided) throw new Error('ctx.sessions.create() did not throw the remote-proxy guidance');

    // --- 2. daemon handshake -------------------------------------------------
    // The first list() call lazily connects the SSH exec channel and runs the
    // pairing handshake; retry while the remote deploy/boot settles.
    let summaries;
    const deadline = Date.now() + 120_000;
    for (;;) {
      try {
        summaries = await ctx.remoteSessions.list(TARGET_ID);
        break;
      } catch (err) {
        if (Date.now() > deadline) throw err;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
    const before = summaries.length;

    // --- 3. create a session through the seam swap ---------------------------
    // agents.create → RemoteAgentFactory.createAgent → client.create (write
    // attach) + seq-exact mirror. The caller-supplied sessionId CANNOT be
    // honored (the daemon mints ids); the returned agent.id IS the remote id.
    const created = await ctx.agents.create({
      sessionId: 'smoke-caller-id',
      meta: { cwd: '/home/dsh/work' },
    });
    const sessionId = String(created.agent.id);

    // --- 4. remote visibility: list + history + fork-at-seq -------------------
    // session.list covers live sessions plus cold ones from the persistence
    // index; ours is live (state 'active').
    summaries = await ctx.remoteSessions.list(TARGET_ID);
    const summary = summaries.find((s) => s.sessionId === sessionId);
    if (!summary) throw new Error(`remote list does not contain the created session ${sessionId}`);
    if (summary.state !== 'active') {
      throw new Error(`remote session ${sessionId} is ${summary.state}, expected active`);
    }

    // Cold-style reads without resuming: read-mode attach (unlimited readers;
    // the proxy's mirror holds the write lease) → seq-paginated history.
    const reader = await ctx.remoteSessions.attach(TARGET_ID, sessionId, { mode: 'read' });
    const page = await reader.history({ maxMessages: 50 });

    // Fork via the remoteSessions fork API: fork-at-seq keeps the history up
    // to and including atSeq (the rewind/time-travel semantic); with an empty
    // log, fork at the head instead.
    const headSeq = page.entries.length > 0 ? page.entries[page.entries.length - 1].seq : undefined;
    const forked = await reader.fork(headSeq !== undefined ? { atSeq: headSeq } : {});
    await reader.detach();

    // The forked child has no live runtime yet — it must surface in the
    // remote list via the cold-session index.
    summaries = await ctx.remoteSessions.list(TARGET_ID);
    if (!summaries.some((s) => s.sessionId === forked.sessionId)) {
      throw new Error(`remote (cold) list does not contain the forked session ${forked.sessionId}`);
    }

    // --- 5. optional LLM round trip --------------------------------------------
    if (process.env.DSH_SMOKE_LLM_KEY) {
      // TODO(Wave 2): real LLM round trip + approval bridge exercise —
      // prompt the remote agent (created.agent.followup / handle.prompt),
      // assert assistant/message mirrors back through the local bus, and
      // register a local approval answerer to prove the remote
      // approval/request bridge lands on ctx.approval.
    }

    await created.dispose();

    console.error(
      `${MARK_OK} sessions=${sessionsName} agents=${agentsName} persistence=${persistenceName}`
        + ` remoteSessions=${remoteSessionsName} sessionsBefore=${before}`
        + ` session=${sessionId} historyEntries=${page.entries.length} fork=${forked.sessionId}`,
    );
    process.exit(0);
  })().catch(fail);
}

// Activate only once all five services are mounted by the composition tree.
dshRemoteDaemonSmoke.inject = ['sessions', 'agents', 'sessionPersistence', 'remoteHub', 'remoteSessions'];
