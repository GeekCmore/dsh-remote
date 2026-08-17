# @dsh-remote/bundle-daemon-tui

dsh profile bundle for **daemon mode** targeting **in-process TUI
frontends**: the local TUI process talks only to the official dsh session
seams (`ctx.sessions` / `ctx.agents` / `ctx.sessionPersistence`), and this
bundle makes those seams **remote-backed** — the sessions, agent loop, LLM
calls and the whole execution world live inside a headless dsh on a remote
Linux host, while the local process renders the frontend. Attach/detach is
tmux-style: close the TUI, the remote session keeps running; reconnect and
resume from a seq cursor.

Compared to `@dsh-remote/bundle-daemon` (which *adds* `ctx.remoteSessions`
for remote-aware frontends), this bundle goes one step further: it *swaps*
the seam implementations themselves, so a frontend that was written against
the stock dsh seams attaches to the remote host **unmodified**.

The remote half is `@dsh-remote/remote-backend`, deployed once per target
with `dsh-remote-backend init` (installs the backend plugin into the remote
headless profile and issues the 256-bit pairing token). The daemon channel
runs as an SSH exec process (`dsh-remote-backend serve`) speaking newline
JSON-RPC on stdio with an HMAC challenge-response handshake — no TCP port is
opened on the remote host.

## What the patch does

Applied after `@deepseek-ai/dsh-base`, the layer **disables** three base
rows and **inserts** three new ones:

Disabled (a patch cannot change a row's plugin `name`, so swapping a
provider = disable the base row + insert a new one):

1. `session` (`@deepseek-ai/dsh-session`) — the local `ctx.sessions` store.
2. `agent` (`@deepseek-ai/dsh-agent`) — the local `ctx.agents` registry.
3. `session-persistence-jsonl`
   (`@deepseek-ai/dsh-session-persistence-jsonl`) — the local
   `ctx.sessionPersistence` backend. Session logs then live only on the
   remote host.

Inserted:

1. `remote-ssh` — `ctx.remoteHub`, the ssh2 connection owner. Each daemon
   target carries a `pairingTokenRef`.
2. `remote-daemon` — `ctx.remoteSessions`: list/attach/prompt/cancel/fork
   over the daemon protocol, with exclusive-write leases and seq-cursor
   resume. Its `resolveToken` maps a target's `pairingTokenRef` to the
   token; the shipped default treats the ref as the name of an environment
   variable.
3. `remote-proxy` (`@dsh-remote/proxy`) — the seam swap: remote-backed
   `sessions` / `agents` / `sessionPersistence` driving the remote host
   through `ctx.remoteSessions`, plus bridges that relay remote
   approval/question requests into the **local** `ctx.approval` /
   `ctx.userQuestions` services — so the dsh-base `approval` and
   `user-questions` rows stay and the frontend's existing answerers render
   remote prompts unmodified.

Everything else stays: rows that merely *inject* `sessions`/`agents`
(session titles, `/compact`, subagent tooling, …) keep working because the
proxy re-provides the same service keys, and the local execution world
(`fs-sandbox`, `subprocess`, sandboxes) is untouched — in daemon mode
execution happens inside the remote host, never rerouted from the local
process.

## Composition

Reference the bundle from a profile manifest alongside a TUI frontend
bundle (e.g. the stock dsh TUI or another seam-compliant in-process TUI):

```json
{
  "dependencies": {
    "@dsh-remote/bundle-daemon-tui": "<version>",
    "<your-tui-bundle>": "<version>"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@dsh-remote/bundle-daemon-tui",
        "<your-tui-bundle>"
      ]
    }
  }
}
```

This bundle must come **after** `@deepseek-ai/dsh-base` (it disables base
rows by id and replaces their services); the TUI bundle's own position
follows its own documentation.

## Prerequisites

1. On the remote host: `dsh-remote-backend init` — installs the backend
   plugin into a headless dsh profile and prints the pairing token once.
   The remote host needs Node + that headless profile; see the
   `@dsh-remote/backend` README.
2. Locally: export the token under the ref name (default
   `DSH_REMOTE_TOKEN`), and point the target at the host via the
   environment — `DSH_REMOTE_HOST`, `DSH_REMOTE_PORT` (default 22),
   `DSH_REMOTE_USER` (default `$USER`), SSH agent auth — or by restating
   the **whole** `remote-ssh` row config in the profile's
   `cordis.patch.yml` (patching replaces, never merges):

```yaml
- id: remote-ssh
  name: '@dsh-remote/remote-ssh'
  config:
    targets:
      - id: default
        pairingTokenRef: DSH_REMOTE_TOKEN
        ssh:
          host: build.example.com
          username: dsh
          auth: { type: key, privateKeyPath: /home/me/.ssh/id_ed25519 }
```

## What works

- Session list / create / resume / prompt / streaming, all executed on the
  remote host; the local TUI renders the event stream.
- Approvals and `ask_user_question`: raised by the remote session, bridged
  into the local `approval` / `userQuestions` services, answered by the
  TUI's stock answerers, relayed back.
- History: session logs live on the remote host (append-only JSONL, owned
  by the remote profile); resume reads them through the daemon protocol.
- Fork-at-seq time travel: fork a session at any event sequence number.
- `/compact` and other seam-driven commands, executed remotely.
- Reconnect with seq-cursor resume; one exclusive write lease per session,
  unlimited readers.

## What degrades

- **Rewind = fork-at-seq only.** The remote session logs are append-only;
  there is no in-place truncation, so "rewind to turn N" is realized as a
  fork at that sequence number (a new session lineage), not a rollback.
- **No fsSnapshot rollback.** File-state snapshots/restores tied to session
  checkpoints are not part of the daemon protocol; fork-at-seq restores
  conversation state only.
- **Catalogs are the local host's own rows in v1.** Model/provider catalogs
  (the `llm` rows, settings, credentials) come from the *local* profile's
  base rows, not the remote host's — pickers show local configuration while
  generation happens remotely. Keep both sides' model settings aligned.

## Support boundary

Only frontends consuming the **official dsh seams** (`ctx.sessions`,
`ctx.agents`, `ctx.sessionPersistence`, plus the standard
`approval`/`userQuestions` answerer pattern) are supported. Frontends that
bypass the seams — reading session-log files directly via `node:fs`, poking
private plugin APIs, or assuming sessions live under the local `$DSH_HOME`
— are **not** supported: with this bundle nothing session-shaped exists on
the local disk, and such access will silently misbehave or fail.

## Caveats

- Consumers that need a synchronous PID (e.g. ACP subagents) are not
  supported against daemon targets; the daemon protocol is event-based.
- The pairing token never goes on the wire; SSH authenticates machine
  access, the token authenticates the frontend. Rotate with
  `dsh-remote-backend init --rotate-token` on the remote host.
