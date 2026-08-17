# @dsh-remote/proxy

Remote-backed implementations of the official dsh session seams for the
**local** dsh host, so seam-compliant in-process frontends (TUIs like
dsh-tianshu-tui / dsh-TUI) attach to a remote headless dsh **unmodified**.

Where `@dsh-remote/remote-daemon` exposes the `ctx.remoteSessions` attach
vocabulary (for remote-aware frontends), this package goes one level deeper:
it mounts the **real upstream service classes** on the plugin context, backed
by a remote daemon through `@dsh-remote/client`:

| Context key | Mounted implementation |
|---|---|
| `sessions` | the real upstream `SessionStore` (`@deepseek-ai/dsh-session`) |
| `agents` | the real upstream `AgentRegistry` (`@deepseek-ai/dsh-agent`) with a remote `AgentFactory` |
| `sessionPersistence` | `RemoteSessionPersistence`, a subclass of the upstream abstract `SessionPersistence` (`@deepseek-ai/dsh-session-persistence`) |

Because the mounted objects *are* the upstream classes, every upstream event
(`session/created`, `session/event`, `agent/created`, `agent/status`, …) and
every upstream behavior (store hooks, registry roots, flush barriers) works
exactly as a local frontend expects.

## Usage

```ts
import RemoteProxyPlugin from '@dsh-remote/proxy';

// after (or before — inject waits) the ctx.remoteSessions provider:
ctx.plugin(DaemonRemoteSessions, { /* … */ });
ctx.plugin(RemoteProxyPlugin, { targetId: 'default' });
```

Config: `{ targetId?: string }` (default `'default'`) — one target per
profile in v1. The composed `ctx.remoteSessions` provider must expose its
`RemoteClient` as `.client` (`DaemonRemoteSessions` does); the plugin waits
on the `remoteSessions` service via cordis `inject`, so composition order
does not matter.

## How it works

**Seq-exact mirroring.** Every ACTIVE remote session is pre-mirrored
(read-mode attach): the remote log is paged in via `session.history` and
replayed into a real upstream `Session` *before* it enters the store, so the
local seq numbers are identical to the remote ones and no `session/event`
flood is published during replay. Live events then append through the
genuine store hooks. A seq violation (gap, duplicate, failed append) freezes
the mirror (`mirror.failed`) rather than corrupting the local log. The
mirror's log is owned by the remote host: `session.append` on a mirrored
session is shadowed so only the mirror itself may write — a local append
(e.g. the local session-title fallback reacting to a replayed
`user/message`) throws instead of silently diverging the seq line. Wire
events that carry no `surfaceOp` are appended with the default `'append'`
intent; `time` / `ignorable` metadata is not preserved across the wire.

**Agent facades.** `AgentRegistry.create/resume` route through a
`RemoteAgentFactory` (`registry.setFactory`):
- `create` calls `client.create` (write-mode attach) and returns an
  `AgentHandle` whose `agent` is a `RemoteAgentFacade` over the mirrored
  session. **The caller-supplied `sessionId` cannot be honored** — the
  daemon mints session ids; the wire has no client-chosen id. `{ seed }` is
  rejected: a remote fork must match the daemon's own log prefix — use
  `sessions.forkRemote(source, { atSeq })` (async) instead.
- `resume` escalates an already-mirrored session's handle to write control
  in place, or cold-reads via `sessionPersistence.prepare` + write attach.

The facade's `session` and `inbox` are real upstream objects fed by the
mirror; `status` tracks the handle's coarse running/idle stream and
re-emits `agent/status` locally; `ctx` is a genuine dsh-scope context keyed
by the facade.

**Approval/question bridging.** Remote `approval.request` /
`question.ask_user_question` notifications (pending-replay included) are
surfaced to the frontend's *existing* UI:
- Approvals dispatch the **local `approval/request` waterfall** with an
  upstream-shaped `ApprovalRequest` (the `agent`/`session` references are
  the local mirrored objects, so `req.agent.session.id` routing works). The
  outcome is forwarded via `handle.answerApproval` (`'allowed-once'` →
  approve, everything else → deny with the outcome as note). The bridge
  deliberately does **not** call `ApprovalService.request()`: that method
  appends a local `approval/asked` + `approval/decided` audit pair — which
  would corrupt the seq-exact mirror and duplicate the remote host's own
  audit pair, which already arrives over the wire — and it hard-requires an
  open local turn, which races with channel-level notification delivery.
  Fail-closed semantics match upstream `decide()`: no answerer, a throwing
  answerer, or a rogue outcome all normalize to `'unavailable'`.
- Questions go through the local `ctx.userQuestions` service
  (`UserQuestionService.ask`); answers are translated back to the wire shape
  (option labels → option ids). With no local provider the question is left
  pending remotely (another attached client may answer) rather than answered
  dishonestly.

## Deliberate degradations

- `followup` / `steer` / `inject` / `send` all route to
  `handle.prompt(text)`: the wire carries only prompt submission, so
  steering/inject timing nuances belong to the remote loop. **Non-text
  content blocks are dropped** (with a one-time warning) — wire prompt
  blocks carry base64 images while upstream `ImageBlock`s carry attachment
  refs; there is no honest mapping.
- `agent/inbox/claimed` is never synthesized locally: turn ownership of a
  claim is a remote-loop fact the durable splice event does not carry.
- `sessions.create()` / `sessions.fork()` throw synchronously with guidance
  (their sync signatures cannot do remote round trips) — use
  `agents.create()` / `sessions.forkRemote()`.
- Mirrored sessions report `firstLiveSeq = 0` and mirrored events do not
  preserve remote `time` / `ignorable` metadata.
- If an approval is settled remotely while a local prompt is still open,
  forwarding the local answer fails and is logged (first answer wins).

## Not proxied (by design, v1)

- **Catalogs** (`ctx.llm`, skills, agent presets) are NOT replaced — read
  remote catalogs explicitly via `client.listCatalog` if needed.
- **`fsSnapshot` rollback / in-memory truncation**: time-travel is
  `sessions.forkRemote(source, { atSeq })`, matching daemon semantics.
- **LSP** and other non-session seams stay local.
- `sessionPersistence.create` / `append` are deliberate no-ops (the remote
  host is the source of truth for durability; a local copy would fork it).
  The service participates in `session/flush` barriers honestly — the remote
  host's own checkpointing owns actual durability.

## Tests

`pnpm --filter @dsh-remote/proxy test` — unit specs (mirror, agent facade,
persistence, bridges) plus a real-stack e2e (`tests/e2e`) running the proxy
against a real `BackendServer` over in-memory byte pipes, reusing the
BackendRig pattern from `@dsh-remote/remote-daemon`.
