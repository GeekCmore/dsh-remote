# dsh-remote design (final)

SSH remote control for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness),
transparent to all frontends (CLI/TUI/GUI/SDK). This document condenses the
settled design; per-package behavior lives in each package's source and tests.

## Two modes

The official dsh remote-execution route is *replacing capability-seam
providers as an environment-consistent group* (the `fs-e2b`/`subprocess-e2b`
POC is the template), not adding a network backend to the sandbox. We follow
it with two modes that share one protocol core:

- **live mode** — the dsh host process stays local (session log, agent loop,
  approvals, LLM calls all local); only the *execution world* (`ctx.fs` +
  `ctx.subprocess`) points at the remote host. **Agentless**: SFTP + exec
  channels + a remote bash wrapper; nothing installed remotely. A dropped
  connection surfaces as typed errors (`CONN_LOST`) that abort the turn
  cleanly.
- **daemon mode** — a full headless dsh runs on the remote host and owns the
  sessions; local frontends are remote controls (attach/detach, tmux-style).
  Local process exit never interrupts a remote session.

Transport decision: **option A (hybrid)** — live mode is agentless, daemon
mode alone deploys `remote-backend`. (Rejected: option B, one backend for
both modes — it would force Node + backend installation on every target,
defeating live mode's zero-deployment goal.)

## Package structure

| Package | Side | Role | ctx key |
|---|---|---|---|
| `remote-core` | shared | Wire vocabulary: newline JSON-RPC 2.0, channel mux, base64 data framing, error codes, pairing auth | library, none |
| `seams` | frontend | Vendored upstream seam definitions (`ctx.fs`, `ctx.subprocess`), MIT-adapted for standalone compilation | declares `fs`, `subprocess` |
| `remote` | frontend | Connection-owner definition + transport SPI | declares `remoteHub` |
| `remote-ssh` | frontend | ssh2 implementation: `SshTransport` + `SshRemoteHub` | provides `remoteHub` |
| `fs-ssh` | frontend | fs seam over SFTP + exec | provides `fs` |
| `subprocess-ssh` | frontend | subprocess seam over exec wrapper + PTY | provides `subprocess` |
| `remote-sessions` | frontend | Daemon-mode session vocabulary + handle façade | declares `remoteSessions` |
| `remote-daemon` | frontend | `remoteSessions` over the daemon protocol | provides `remoteSessions` |
| `remote-frontend` | frontend | Transfer/preview, monitor, `remote_copy` tool | provides `remoteTransfer`, `remoteMonitor` |
| `remote-backend` | backend | Daemon-side plugin: broker, approval/question bridges, lease, monitor, transfer | runs in the remote headless dsh |
| `bundle-live` / `bundle-daemon` | profile | dsh profile bundles (`dsh.bundle` patch) | composition only |

`ctx.remoteHub` mirrors the `ctx.e2b` pattern: one service owns the
connection, runtime root (`$HOME/.cache/dsh-remote/<hex>`, mode `0700`), and
lifecycle events (`remote/connected|disconnected|degraded`); the seam
providers consume it lazily and never open their own connections.

## live mode mechanics

- **fs-ssh**: SFTP for stat/list/read/write streams; exec for what SFTP
  cannot express — `realpath -mz` canonical identity (cached, 5s TTL),
  atomic publish (random 0700 sibling staging dir + same-directory rename;
  `createIfAbsent` via `ln -T`; version/existence guards re-checked inside
  one remote critical section, so check+publish is a single round trip).
- **subprocess-ssh**: remote bash wrapper — `setsid` process groups, real
  PGID published through private state files (handles never trust the exec
  process model; PID is async, `pid = -1` until published), bounded spill
  files with base64 line framing, TERM→grace→KILL escalation by process
  group, PTY via ssh2 `pty-req` (rows/cols/TERM negotiated from the spawn
  spec), foreground-group inspection via procps `ps`.
- **Transparency boundary**: LLM calls, session logs, approvals
  (`approval/request` stays on the local host), workspace registry — all
  untouched. Replacing `ctx.fs` + `ctx.subprocess` transparently remote-izes
  bash, terminal, jobs, LSP, and subagent consumers.

## daemon mode: protocol, handshake, lease

The daemon channel is an SSH **exec process** running
`dsh-remote-backend serve`; newline-framed JSON-RPC 2.0 (sdk/protocol
vocabulary) rides its stdio. No TCP listener — the attack surface is SSH
itself.

The production form is `dsh-remote-backend serve --profile <name>`: the bin
boots the named dsh profile in-process (`@deepseek-ai/dsh-app-boot`), and
the profile's `@dsh-remote/backend` plugin row takes over stdio against the
real host services. Bare `serve` keeps a standalone empty host behind the
protocol — handshake/plumbing smoke only.

Protocol v2 (additive on top of v1): `session.history` (seq-paginated,
never resumes an agent), `session.fork {atSeq}` (the only time-travel
semantic — upstream logs are append-only, there is no truncate API),
`session.compact`, content-block prompts (images via remote
`ctx.attachments`), the `question.request/answer/closed` trio (mirroring
approvals), `catalog.list` (models/skills/agentPresets), and
`pendingInteractions` replay in the attach result. The handshake
advertises capability bits (`Capabilities` in `remote-core/src/auth.ts`);
absent capability → `REMOTE_CAPABILITY_UNSUPPORTED`. Wire evolution is
additive-only, golden-tested in `remote-core/tests/protocol.spec.ts`.

**Pairing authentication** (inside `hello`, on top of SSH auth):

1. F→B `hello`: protocol version, capabilities, client nonce.
2. B→F `hello.challenge`: server nonce.
3. F→B `hello.proof`: `HMAC-SHA256(token, clientNonce ‖ serverNonce ‖ hello)` —
   the token never goes on the wire; challenge-response defeats replay.
4. Failure → `REMOTE_AUTH_FAILED`, channel closed immediately, rate-limited.

SSH authenticates machine access; the pairing token authenticates the
frontend. One token may authorize many frontends; rotation is
`dsh-remote-backend init --rotate-token` plus updating frontend credentials.
The backend assigns the client id in the handshake — it is the only client
identity on the wire (leases name it; nothing is self-chosen).

The v1 backend stores the high-entropy pairing token in a mode-`0600` config
file. This protects against other UIDs, not same-UID processes, backups, or a
disk snapshot. A plain SHA-256 token digest cannot replace the current HMAC
key: using that digest as the key merely makes the digest an equivalent
credential. Stronger at-rest protection requires encrypted/OS secret storage,
public-key pairing, or a verifier/PAKE protocol.

SSH server identity is a separate deployment responsibility. The transport
offers a `hostVerifier` hook, but shipped bundles do not configure one by
default. Production profiles must pin a fingerprint/use known-hosts, or
document an external trusted-SSH boundary. Pairing authentication proves the
frontend knows the token; it does not authenticate the SSH server.

**Exclusive write lease** (per session, in-memory, never persisted):

- `session.attach { mode: 'read' | 'write', sinceSeq? }` — read always
  succeeds (unlimited read concurrency, snapshot + live event fan-out);
  write succeeds only when the lease is free, else `REMOTE_SESSION_LOCKED`
  with the current holder's identity.
- The lease is bound to the connection: disconnect releases it and
  broadcasts `session.control-changed`; `session.control-release` demotes
  voluntarily.
- Preemption requires explicit `force: true` — never silent — and every
  attached party can audit the change (`reason: 'preempted'`).
- Backend restart clears all leases (first come, first served); sessions
  themselves are persisted by the remote dsh and unaffected.

**Resume**: `attach(sinceSeq = lastSeenSeq)` replays from the cursor after
reconnect; subscribers re-attach automatically (duplicates dropped). The
backend also bridges `approval/request` to the write frontend (broadcast to
readers when no writer; fail-closed when nobody is attached) — and likewise
`userQuestions` asks via the `question.*` trio — and serves monitor probes
and transfer endpoints off the critical path. History, compaction, and
read-only catalogs are served from the remote host's own services
(`sessionPersistence`, `ctx.compaction`, `ctx.llm/skills/agentPresets`)
through narrow structural interfaces (`remote-backend/src/host.ts`).

Frontend transparency: `@dsh-remote/proxy` re-provides the official session
seams (`sessions`/`agents`/`sessionPersistence`) backed by
`@dsh-remote/client`, mounting the real upstream Service classes and
replaying the remote log into genuine local `Session` instances; remote
approvals/questions are surfaced through the LOCAL `approval`/`userQuestions`
services so existing frontend panels answer them unchanged. Composition:
`@dsh-remote/bundle-daemon-tui`. See `docs/frontend-connection-api.md`.

## Trade-offs (settled)

| Scenario | Policy | Rationale |
|---|---|---|
| Multi-frontend, one target (live) | Independent SSH connection per frontend; no cross-connection race coordination | Same posture as e2b / everyday SSH |
| Multi-frontend, one session (daemon) | Unlimited read + exclusive write lease, explicit-force preempt, auditable | One in-memory `sessionId→holder` table; clear semantics |
| Pairing auth | HMAC challenge-response inside `hello`; token never on the wire | Two independent layers (SSH = machine, token = frontend) |
| Cold-session resume concurrency | Per-sessionId dedupe inside the backend | Single-process serialization, no distributed lock |
| Metadata/workspace writes | Serialized inside the backend (sole writer) | Natural mutual exclusion |
| File version guards | Re-checked in one remote critical section | Effective per connection; cross-connection races out of scope |
| Approval race | Write frontend first; otherwise first reader answer wins | Wired form of waterfall semantics |
| Security | No TCP listener; SSH credentials and pairing token stored separately; host-key verification hook; runtime root 0700 | Same-UID remote processes can still read control state (acknowledged upstream for E2B too) |

## Known gaps accepted for v1

Synchronous-PID consumers (ACP subagents), remote bootstrap still manual
(`REMOTE_NOT_BOOTSTRAPPED` detection + instructions, auto-bootstrap later),
fs double round trip mitigated by resolve caching, backend/frontend protocol
version drift handled by `hello` capability negotiation. See the root
README's limitation list for the user-facing version.
