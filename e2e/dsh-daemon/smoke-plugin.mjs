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
 *   5. OPTIONAL LLM leg (gated on DSH_SMOKE_LLM_KEY, falling back to
 *      DEEPSEEK_API_KEY; run-smoke.sh injects the same key into the
 *      CONTAINER's credential store, because in daemon mode the model call
 *      happens on the remote host): first registers a local userQuestions
 *      provider and proves a real remote ask_user_question → local answer →
 *      remote completion round trip; then registers a local auto-approving
 *      `approval/request` answerer and proves the existing sandbox-escalation
 *      approval round trip. Without a key it prints one SKIP line and
 *      continues.
 *   6. prints one DSH_REMOTE_DAEMON_SMOKE OK line on stderr (with
 *      `llm=ok question=ok approval=ok` when the LLM leg ran) and exits 0.
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

function messageText(data) {
  const blocks = data?.message?.content;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .flatMap((block) => (Array.isArray(block?.content) ? block.content : [block]))
    .map((block) => (typeof block?.text === 'string' ? block.text : ''))
    .join('');
}

/**
 * Compact digest of a remote history page for the LLM-leg timeout error:
 * event-type histogram, every tool call/result by name, and a snippet of the
 * last assistant text — enough to tell "model never called the tool" apart
 * from "tool ran but the bridge/echo stalled" without dumping raw chunks.
 */
function summarizeRemote(entries) {
  const counts = new Map();
  const tools = [];
  let lastText = '';
  const textOf = (data) => {
    // assistant/chunk: {text}; assistant/message + tool/result:
    // {message: {content: blocks}} (tool/result nests one tool-result block).
    if (typeof data?.text === 'string') return data.text;
    return messageText(data);
  };
  for (const { seq, event } of entries) {
    counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
    if (event.type === 'tool/call') {
      tools.push(`${seq}:call:${event.data?.name}:${JSON.stringify(event.data?.arguments ?? '').slice(0, 200)}`);
    } else if (event.type === 'tool/result') {
      tools.push(`${seq}:result:${textOf(event.data).slice(0, 300)}`);
    }
    if (event.type === 'assistant/chunk' || event.type === 'assistant/message') {
      const text = textOf(event.data);
      if (text) lastText = text.slice(-300);
    }
  }
  const histogram = [...counts.entries()].map(([type, n]) => `${type}×${n}`).join(',');
  return `${histogram} | tools=[${tools.join(' | ')}] | lastAssistant=${JSON.stringify(lastText)}`;
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

    // Cold-style reads without resuming: seq-paginated history over the
    // remoteSessions handle. NOTE: attach() is idempotent per (target,
    // session), so this "reader" IS the proxy mirror's write handle — it must
    // NOT be detached here (detach is terminal for the shared handle: it would
    // kill the mirror's event tap, the status feed, and the approval-bridge
    // wiring the LLM leg below depends on). The write lease the handle holds
    // is also what makes fork() legal on the daemon side.
    const reader = await ctx.remoteSessions.attach(TARGET_ID, sessionId, { mode: 'read' });
    const page = await reader.history({ maxMessages: 50 });

    // Fork via the remoteSessions fork API: fork-at-seq keeps the history up
    // to and including atSeq (the rewind/time-travel semantic); with an empty
    // log, fork at the head instead.
    const headSeq = page.entries.length > 0 ? page.entries[page.entries.length - 1].seq : undefined;
    const forked = await reader.fork(headSeq !== undefined ? { atSeq: headSeq } : {});

    // The forked child has no live runtime yet — it must surface in the
    // remote list via the cold-session index.
    summaries = await ctx.remoteSessions.list(TARGET_ID);
    if (!summaries.some((s) => s.sessionId === forked.sessionId)) {
      throw new Error(`remote (cold) list does not contain the forked session ${forked.sessionId}`);
    }

    // --- 5. optional LLM round trips + question/approval bridges ---------------
    // Gated on a model key (DSH_SMOKE_LLM_KEY wins, DEEPSEEK_API_KEY is the
    // fallback); the key itself is only a presence signal here — the remote
    // host got it through its own credential store (see run-smoke.sh).
    let llmLeg = '';
    if (process.env.DSH_SMOKE_LLM_KEY ?? process.env.DEEPSEEK_API_KEY) {
      const QUESTION_MARKER = 'dsh-remote-question-ok';
      const MARKER_TEXT = 'dsh-remote-llm-ok';
      const questions = [];
      const disposeQuestionProvider = ctx.userQuestions.registerProvider({
        ask: async (req) => {
          questions.push(req);
          return { answers: [{ id: 'smoke-choice', selected: ['Continue'] }] };
        },
      });
      // The local answerer the proxy's bridge is meant to reach: a remote
      // approval/request is dispatched onto the LOCAL approval waterfall; an
      // 'allowed-once' here maps to a wire 'approve' that unblocks the
      // remote turn.
      const approvals = [];
      ctx.on('approval/request', async (req) => {
        approvals.push({ toolName: req.toolName, reason: req.reason });
        return 'allowed-once';
      });

      // attach() is idempotent per (target, session) and returns the mirror's
      // own write handle — the exact handle followup() would route to. The
      // awaited prompt() surfaces immediate remote rejection.
      const writer = await ctx.remoteSessions.attach(TARGET_ID, sessionId, { mode: 'write' });
      // Wire-level tap, independent of the mirror: distinguishes "the daemon
      // never delivered seq N to this handle" from "the mirror received seq N
      // but failed to append it" when the two diverge on timeout.
      const wireSeqs = [];
      const offWire = writer.onEvent((ev) => wireSeqs.push(ev.seq));

      // First prove the question bridge against the real upstream
      // AskUserQuestionRequest shape on both hosts.
      const QUESTION_PROMPT =
        'Immediately call the ask_user_question tool with exactly one question and no preamble. ' +
        'Use id "smoke-choice", header "Remote question", question ' +
        '"Choose Continue to finish the question smoke.", and two options: ' +
        'label "Continue" with description "Complete the smoke", and label "Stop" ' +
        'with description "Do not complete it". Your first action must be that tool call. ' +
        `After the answer returns, reply with exactly ${QUESTION_MARKER} and nothing else.`;
      await writer.prompt(QUESTION_PROMPT);

      const questionDeadline = Date.now() + 180_000;
      let questionEchoed = false;
      for (;;) {
        questionEchoed = created.agent.session.events.some(
          (ev) =>
            ev.type === 'assistant/message' &&
            messageText(ev.data).trim() === QUESTION_MARKER,
        );
        if (questionEchoed && questions.length > 0) break;
        if (Date.now() > questionDeadline) {
          const remotePage = await writer.history({ maxMessages: 400 });
          throw new Error(
            `question round trip timed out after 180s: echoed=${questionEchoed}`
              + ` questions=${JSON.stringify(questions.map((request) => request.questions))}`
              + ` localSeq=${created.agent.session.seq} wireSeqs=${wireSeqs.length}`
              + ` remote=${summarizeRemote(remotePage.entries)}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      const receivedQuestion = questions[0];
      const receivedItem = receivedQuestion?.questions?.[0];
      if (receivedQuestion?.agent !== created.agent) {
        throw new Error('bridged question did not carry the exact mirrored root agent');
      }
      if (
        receivedItem?.id !== 'smoke-choice' ||
        receivedItem?.header !== 'Remote question' ||
        receivedItem?.question !== 'Choose Continue to finish the question smoke.' ||
        receivedItem?.options?.[0]?.label !== 'Continue'
      ) {
        throw new Error(`bridged question shape mismatch: ${JSON.stringify(receivedItem)}`);
      }

      // A plain in-workspace command never asks approval in the default
      // workspace-write mode, so the command MUST cross the sandbox fence.
      // NOTE: /tmp is NOT a fence crossing — upstream workspace-write allows
      // the workspace root AND /tmp + os.tmpdir(). /var/tmp is outside the
      // allow-list (so the confined run is denied) yet writable by the remote
      // user once the approved escalation re-runs unconfined — the denial
      // plus the tool's standing instruction makes the model retry once with
      // sandbox_permissions + justification, and that retry is the approval
      // the bridge relays.
      //
      // The prompt is deliberately imperative: reasoning models happily
      // narrate a plan for minutes without ever emitting the tool call, so
      // order an IMMEDIATE call, by tool name, with no explanation.
      const PROMPT_TEXT =
        `Immediately call the bash tool (tool name: "bash") to run exactly this command, ` +
        `with no explanation, plan, or preamble — your first action must be the tool call:\n` +
        `echo ${MARKER_TEXT} | tee /var/tmp/dsh-remote-llm-smoke.txt\n` +
        'If the sandbox denies the write, retry the exact same command once ' +
        'with sandbox_permissions plus a one-sentence justification. Once the ' +
        `command has run, reply with exactly its stdout and nothing else.`;
      await writer.prompt(PROMPT_TEXT);

      const llmDeadline = Date.now() + 300_000;
      let echoed = false;
      let lastBeat = 0;
      for (;;) {
        for (const ev of created.agent.session.events) {
          if (ev.type === 'assistant/message' && JSON.stringify(ev.data).includes(MARKER_TEXT)) {
            echoed = true;
          }
        }
        if (echoed && approvals.length > 0) break;
        if (Date.now() > llmDeadline) {
          // Distinguish "prompt never landed remotely" from "mirror stalled":
          // read the REMOTE log through the same shared handle before failing.
          // Include a data-level tail (last assistant text / tool events), not
          // just types — "model rambled without a tool call" vs "tool call
          // denied, no escalation" look identical at the type level.
          let remoteDigest = 'unreadable';
          try {
            const probe = await ctx.remoteSessions.attach(TARGET_ID, sessionId, { mode: 'read' });
            const remotePage = await probe.history({ maxMessages: 400 });
            remoteDigest = summarizeRemote(remotePage.entries);
          } catch (probeErr) {
            remoteDigest = `probe failed: ${String(probeErr)}`;
          }
          throw new Error(
            `LLM round trip timed out after 300s: echoed=${echoed}`
              + ` approvals=${JSON.stringify(approvals)}`
              + ` localSeq=${created.agent.session.seq} wireSeqs=${wireSeqs.length}`
              + ` wireHead=${wireSeqs.length > 0 ? wireSeqs[wireSeqs.length - 1] : 'none'}`
              + ` localEvents=${created.agent.session.events.map((e) => e.type).join(',')}`
              + ` remote=${remoteDigest}`,
          );
        }
        if (Date.now() - lastBeat > 15_000) {
          lastBeat = Date.now();
          const remoteState = await ctx.remoteSessions
            .list(TARGET_ID)
            .then((list) => list.find((s) => s.sessionId === sessionId)?.state ?? 'absent')
            .catch((err) => `list failed: ${String(err)}`);
          console.error(
            `[smoke] llm-wait: localStatus=${created.agent.status}`
              + ` localEvents=${created.agent.session.events.length} remoteState=${remoteState}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      if (approvals[0].toolName !== 'bash') {
        throw new Error(`bridged approval was for ${String(approvals[0].toolName)}, expected bash`);
      }
      offWire();
      disposeQuestionProvider();
      llmLeg = ' llm=ok question=ok approval=ok';
    } else {
      console.error('DSH_REMOTE_DAEMON_SMOKE SKIP llm (no DSH_SMOKE_LLM_KEY / DEEPSEEK_API_KEY)');
    }

    await created.dispose();

    console.error(
      `${MARK_OK} sessions=${sessionsName} agents=${agentsName} persistence=${persistenceName}`
        + ` remoteSessions=${remoteSessionsName} sessionsBefore=${before}`
        + ` session=${sessionId} historyEntries=${page.entries.length} fork=${forked.sessionId}${llmLeg}`,
    );
    process.exit(0);
  })().catch(fail);
}

// Activate only once all services used by the seam and interaction checks are mounted.
dshRemoteDaemonSmoke.inject = [
  'sessions',
  'agents',
  'sessionPersistence',
  'remoteHub',
  'remoteSessions',
  'userQuestions',
];
