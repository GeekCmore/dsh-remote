# Frontend connection API design

Goal: let any dsh frontend attach to a remote dsh with minimal cost and
maximal fidelity. Scope discipline: **we do not prescribe which mode a
frontend uses or how deeply it integrates. We only standardize the seam
vocabulary and ship remote-backed implementations of the official seams the
frontends already consume.**

Builds on `docs/design.md` (settled protocol, handshake, lease) and a survey
of four frontends: the official web stack (`deepseek-ai/deepseek-harness`),
`nexu-io/open-design`, `zhu1090093659/dsh-web-ui`, and
`huiliyi37/dsh-tianshu-tui`.

## The one idea

Frontends never talk to "dsh-remote". They talk to **official dsh seams** —
the cordis service keys and event channels defined by dsh-base. Our entire
API is: **the same seam interfaces, implemented against a remote host.**

```
frontend ── consumes ──► official seam interfaces (ctx.*)
                              ▲ implements, unchanged shape
              ┌───────────────┴────────────────┐
        live-mode providers              daemon-mode providers
        (fs-ssh, subprocess-ssh)         (remote-backed sessions, agents, …)
              │                              │
        SSH: SFTP + exec               wire protocol (JSON-RPC over SSH exec)
        (agentless)                          │
                                       remote-backend, inside the remote dsh,
                                       adapts the wire to the real services
```

There is no fourth component. The two boxes on the left are the **same seam
interfaces with two different transports behind them**; choosing between them
is a profile-composition decision, invisible to the frontend.

## The seam set (the contract we standardize)

Everything a surveyed frontend consumes reduces to three seam groups. This
set *is* our API surface; nothing outside it is our business.

**Execution seams** (already shipped, live mode):

| Seam | Provider | Status |
|---|---|---|
| `ctx.fs` (`FileSystem`, 12 primitives) | `fs-ssh` over SFTP+exec | done |
| `ctx.subprocess` (`SubprocessRuntime`) | `subprocess-ssh` over exec wrapper + PTY | done |

**Session seams** (daemon mode; protocol v2, implemented):

| Seam | Consumed by frontends as | Wire realization |
|---|---|---|
| `ctx.sessions` | `list/get/fork/flush` | `session.list/create/fork {atSeq?}` |
| `ctx.agents` | `create/resume/get` → handle with `followup/steer/inject/cancel/whenIdle` | `session.attach/prompt/cancel` + event stream |
| `ctx.sessionPersistence` | `list/inspect` (history **without** resuming an agent) | `session.history` (seq-paginated) |
| `session/event` bus | rendering (`ctx.on('session/event')` / mux frames) | `session.event` — **verbatim passthrough** |
| `approval/request` waterfall | approval panels | `approval.request/answer/closed` |
| `ctx.userQuestions` | ask_user_question panels | `question.request/answer/closed` |
| compaction (`ctx.compaction`) | `/compact` | `session.compact` |
| time-travel | rewind/fork pickers | **`session.fork {atSeq}` only** — upstream logs are append-only at rc.6 (no truncate API exists), so fork-at-boundary is the fidelity ceiling |
| attach recovery | reconnect refresh | attach result carries `pendingInteractions` (stable ids), replaying outstanding approvals/questions |

**Catalog seams** (read-only picker data):

| Seam | Consumed as | Wire realization |
|---|---|---|
| `ctx.llm` | `listProviders/listModels`, model pickers | `catalog.list {kind:'models'}` (v2) |
| `ctx.skills` | skill lists | `catalog.list {kind:'skills'}` (v2) |
| `ctx.agentPresets` | preset pickers | `catalog.list {kind:'agentPresets'}` (v2) |
| `ctx.attachments` | durable image blocks in prompts | `session.prompt` with content blocks (extends today's text-only call) |

Notable non-seams, deliberately excluded: `host.pickDirectory` /
`host.openPath` (local-desktop operations by design), `fsSnapshot.histories`
rollback, in-memory `Session.truncate`, LSP. These cannot cross a process
boundary sanely; a remote-backed provider simply leaves them **absent**, and
frontends degrade the way they already do for optional services
(tianshu-tui's `ctx.reflect.get` fail-loud pattern; the web RPC contract
tolerates absent capabilities).

## The two transports

**Live mode (exists).** The seam providers hold an SSH connection directly
(SFTP + exec). Nothing session-related crosses the wire; sessions, approvals,
LLM calls stay local by construction. No new work in this design except the
rc-version alignment of the vendored seam definitions.

**Daemon mode (the wire is a projection of the seam set).** The daemon
protocol is not a new API — it is the *serializable subset* of the session
and catalog seams above, plus the control concerns a wire genuinely adds:
pairing auth, write lease, reconnect with seq cursor. `remote-backend`, running
inside the remote dsh, adapts each wire method back onto the real upstream
services. Protocol v2 (implemented) added: `session.history`,
`session.fork {atSeq}`, `session.compact`, the `question.*` trio,
`catalog.list`, content-block prompts, `pendingInteractions` replay, and
real capability negotiation on the handshake.

## The two delivery packages

The remote-backed seam implementations ship in two packages that share one
core — they differ only in wrapping, not in behavior:

- **`@dsh-remote/proxy`** (implemented) — a cordis plugin that occupies the
  official service keys (`sessions`, `agents`, `sessionPersistence`) in a
  local dsh host with remote-backed implementations, backed by the client.
  Strategy: it mounts the **real upstream Service classes**
  (`SessionStore`/`AgentRegistry`/`SessionPersistence` from the upstream
  definition packages) and drives them with remote data — the remote event
  log is replayed into genuine local `Session` instances (seq-exact), so the
  `session/event` bus and every log invariant come free. Only `Agent` (a
  plain interface, via the registry's `AgentFactory` seam) and `AgentHandle`
  are facades. Remote approvals/questions are surfaced by **invoking the
  local** `approval`/`userQuestions` services with the mirrored session/agent
  context, so the frontend's own panels render them; outcomes are bridged
  back over the wire. In-process plugin frontends (TUIs; the official web
  stack's host side, whose apiproxy reads exactly these services) consume
  them with zero changes.
- **`@dsh-remote/client`** (implemented) — the same capabilities
  materialized as plain TypeScript objects, no cordis. For out-of-process
  hosts (open-design-style) that want to drive a remote dsh without embedding
  the framework.

The official web BFF (apiproxy) is **not** something we build or replace: it
is upstream's own projection of the seam services onto HTTP/WS. Once our
providers occupy the seam keys, it works unmodified. That is the payoff of
standardizing on seams instead of shipping a bespoke frontend protocol.

## Stability contract

Frontends pin versions hard (every surveyed project pins the dsh rc exactly;
open-design probes and rejects version drift). So the contract is explicit:

1. **The seam interfaces are the contract for in-process consumers** — we
   keep them structurally identical to upstream by vendoring the definitions
   (existing `packages/seams` discipline) and adding a CI contract gate that
   diffs upstream `.d.ts` per supported rc (the dsh-TUI `verify:contract`
   pattern). dsh-base updates are absorbed here and in `remote-backend`, the
   only two places coupled to upstream internals.
2. **The wire protocol is the contract for the daemon channel** — additive
   only (new methods, new optional fields, new event types; never removals),
   every post-v1 method gated by a `hello` capability bit, `SessionEvent`
   payloads forwarded verbatim including unknown types, error codes
   namespaced (`REMOTE_*`) and append-only. Enforced by golden tests.
3. **`@dsh-remote/client` is semver'd** for out-of-process consumers; it
   negotiates capabilities with the backend, so an older backend degrades
   cleanly instead of breaking.
4. **Absence is the degradation story.** A seam that cannot be remote-backed
   is left unprovided; capability bits say what a given daemon supports.
   Frontends written against upstream optional-service conventions handle
   both already.

## What this deliberately does not include

- Per-frontend integration work: lease-conflict UI, clipboard-image byte
  paths, an embedding host's own adapter code. Frontends own their side; the
  seam interfaces are the whole meeting point.
- A bespoke frontend protocol or UI kit.
- Prescribing mode choice. Live and daemon are interchangeable transports
  behind the same seams; the profile picks, the frontend never knows.

**Support boundary:** only frontends consuming the official dsh seams are
supported. Frontends that bypass the seams (reading session JSONL files
directly via `node:fs`, poking private APIs) are out of scope by policy.

## Implementation status

- **TUI family (done).** Protocol v2 (`remote-core`), backend implementation
  (`remote-backend`), cordis-free `@dsh-remote/client`, the seam proxies
  (`@dsh-remote/proxy`), and the composition bundle
  `@dsh-remote/bundle-daemon-tui` are implemented and tested (unit +
  real-stack e2e over in-memory byte pipes). Known degradations are
  documented in `packages/remote-proxy/README.md` (sync `sessions.create`
  cannot round-trip — use the async path; rewind = fork-at-seq; catalogs are
  read-only remote rows via `catalog.list`; mirror freezes on seq violation rather
  than corrupting the log).
- **Daemon smoke (covered, repeatedly green).** `e2e/dsh-daemon`
  (`pnpm smoke:dsh-daemon`) deploys a real headless dsh into the
  `integration/daemon-host` container, boots it via the
  `dsh-remote-backend serve --profile` self-bootstrap path, and attaches from
  a real local host with the bundle-daemon-tui seam swap, asserting
  create/history/fork over the wire end to end. Given `DSH_SMOKE_LLM_KEY` (or
  `DEEPSEEK_API_KEY`) it additionally runs the LLM leg — first a real
  `ask_user_question` round trip answered by a local `userQuestions` provider,
  then a sandbox-escalation approval answered through the local approval
  waterfall (`llm=ok question=ok approval=ok`; SKIP line and green without a
  key). The wire `session.create` mints the remote session AND its
  live agent together (upstream `ctx.agents.create` contract), so
  wire-created sessions are promptable.
- **Live-mode frontend composition (decided + covered).** Live mode composes
  with TUI-family profiles through the standard bundle mechanism:
  `@dsh-remote/bundle-live` applies after `@deepseek-ai/dsh-base`, and
  `dsh plugin add` registers its patch into `dsh.profile.bundles` — smoke
  tested as the "bundle" scenario in `e2e/dsh-host`. The dsh-base
  `sandbox`/`sandbox-policy` rows deliberately stay enabled (bash-sandbox
  hard-injects them; disabling is boot-fatal); the resulting bash-tool
  semantics — locally probed bwrap/landlock argv executed on the remote host,
  fail-closed where no remote runner exists — are documented in
  `packages/bundle-live/README.md`.
- **Web parity (deferred).** The official web stack's host side hard-injects
  11 services (`agentDefaultModel, agents, attachments, directoryPicker, llm,
  sessions, subagents, sessionQuery, tools, userQuestions, workspaceRegistry`)
  plus ~11 optional ones. The proxy covers the session core today; mounting
  the official apiproxy unmodified requires remote-backed versions (or
  explicit local semantics) for the rest. This is a deliberate later
  milestone — no web-specific work is started.
- **Agent inbox delivery parity (deferred).** The proxy currently projects
  `send`/`followup`/`steer`/`inject` through the ordinary prompt path. This
  loses the upstream next-turn/next-step and wake/no-wake distinctions, and
  non-text attachment references are not yet translated into wire image
  blocks. The rc.7 attachment APIs make image admission/persistence feasible,
  but preserving inbox delivery semantics still requires additive wire
  fields or methods. Until then this is a documented compatibility limit,
  not a silent claim of full agent-inbox parity.
- **Still open.** Web parity (above); client SDK documentation.
- **Frontend neutrality (decided).** Frontend-private seams (e.g. a TUI's
  workspace/shell-escape registry) are adapted on the frontend's own
  integration layer against the generic `ctx.remoteHub`/`ctx.subprocess`
  seams; this repo deliberately ships no frontend-specific adapter packages.

## Evidence appendix: which seams the surveyed frontends consume

| Frontend | Family | Seam consumption (surveyed) |
|---|---|---|
| dsh-tianshu-tui | in-process plugin | injects `sessions`/`agents`/`sessionPersistence`-facet + ~25 optional facets; renders `session/event`; answers `approval/request`; registers `userQuestions` provider |
| dsh-TUI | in-process plugin | same family; `@` completion and mention reads go through `ctx.fs`; approvals via `ctx.approval` |
| official web GUI + dsh-web-ui family | browser ↔ host BFF | host apiproxy reads `ctx.sessions/agents/sessionPersistence/userQuestions/attachments/skills/…` and projects them onto `/api` RPC + mux/host streams; approvals/questions are answerable frames with stable ids replayed on reconnect — matched by our lease + pending-replay semantics |
| open-design | out-of-process host | consumes no cordis services; speaks to a spawned `dsh --stdio`. Maps onto `@dsh-remote/client`; its file-preview loop additionally needs the execution seams (live mode) or the transfer plane |
