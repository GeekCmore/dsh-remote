# dsh-remote

SSH remote-control plugins for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness).

Two modes, both transparent to dsh frontends (CLI/TUI/GUI/SDK):

- **live mode** — replace the `ctx.fs` / `ctx.subprocess` capability-seam providers so a local
  dsh session operates on a remote Linux host. Zero installation on the remote side
  (SFTP + exec channels only).
- **daemon mode** — run a full headless dsh on the remote host and attach/detach sessions
  over SSH (tmux-style). Frontends pair with the backend via an HMAC challenge-response
  handshake; one active writer per session, unlimited readers.

## Packages

| Package | Side | Role |
|---|---|---|
| `@dsh-remote/core` | shared | Wire protocol: newline JSON-RPC 2.0, channel mux, data framing, error vocabulary, pairing auth |
| `@dsh-remote/seams` | frontend | Vendored dsh seam definitions (`ctx.fs`; `ctx.subprocess` later), MIT-adapted for standalone compilation |
| `@dsh-remote/remote` | frontend | `ctx.remoteHub` service definition: abstract `RemoteHub`, transport SPI, SSH target vocabulary (no runtime deps) |
| `@dsh-remote/remote-ssh` | frontend | ssh2-backed `ctx.remoteHub` provider: `SshRemoteHub` + `SshTransport` |
| `@dsh-remote/fs-ssh` | frontend | `ctx.fs` provider over SFTP + exec wrapper (live mode) |
| `@dsh-remote/subprocess-ssh` | frontend | `ctx.subprocess` provider over exec wrapper + PTY (live mode, M2) |
| `@dsh-remote/remote-sessions` | frontend | `ctx.remoteSessions` service definition: attach/detach vocabulary (re-exports the client handle types) |
| `@dsh-remote/client` | frontend | Cordis-free daemon client: pairing handshake, reconnect + seq-cursor resume, write leases, capability negotiation, history/fork-at-seq/compact/prompt-blocks, approval & question bridging API |
| `@dsh-remote/remote-daemon` | frontend | Thin cordis adapter exposing the client as `ctx.remoteSessions` |
| `@dsh-remote/proxy` | frontend | Remote-backed implementations of the official session seams (`sessions`/`agents`/`sessionPersistence`) — daemon-mode transparency for seam-compliant in-process frontends |
| `@dsh-remote/remote-frontend` | frontend | Workspace/session management, monitoring, file interop services |
| `@dsh-remote/remote-backend` | backend | Remote agent plugin: session broker, approval + question bridges, control lease, monitor, transfer endpoints, history/compact/catalog endpoints |
| `@dsh-remote/bundle-live` | profile | dsh profile bundle: live mode — disables the local fs/subprocess backends, mounts the SSH providers |
| `@dsh-remote/bundle-daemon` | profile | dsh profile bundle: daemon-mode frontend — mounts hub + daemon sessions + transfer/monitor |
| `@dsh-remote/bundle-daemon-tui` | profile | dsh profile bundle: daemon mode for seam-compliant TUIs — replaces the local session/agent/persistence rows with the remote-backed proxy |

## Remote target requirements

Both modes expect the remote host to be **Linux** with:

- `sshd` reachable with agent, key, or password auth;
- `bash` (the process/terminal wrapper layer is a bash script);
- GNU **coreutils** (`realpath -mz`, `stat -c`, `base64`, `ln -T`, `mv`, `chmod`, `cat`, `rm`);
- **procps** (`ps` with `-o tpgid=,stat=` / `-eo sid=,pgid=,stat=` for foreground-group
  inspection and session teardown).

Daemon mode additionally requires Node + a headless dsh profile with
`@dsh-remote/remote-backend` installed (`dsh-remote-backend init` sets this up
and issues the pairing token).

## Known limitations

- **mtime granularity**: fs versions incorporate the SFTP mtime, which is
  second-granular; two writes within the same second with the same size and
  mode produce the same version, so a guard may not detect the change.
- **Guarded publish TOCTOU**: version/existence guards are re-checked inside
  one remote critical section per connection, but another harness or shell
  can still race the publish; coordination is in-process only (same stance as
  upstream `fs-e2b`).
- **Async PID / ACP unsupported**: spawned processes publish their real PGID
  asynchronously through a remote state file; consumers requiring a
  synchronous PID (ACP subagents) are not supported.
- **PTY `inputWaiting` is heuristic**: inferred from `ps` sleep states; there
  is no syscall-level proof through SSH, so treat it as advisory.
- **Same-UID confinement only**: the remote runtime root is mode `0700`, but
  processes running as the same remote user (or root) can read private
  control state — the same limitation upstream acknowledges for E2B.
- **Non-atomic upload side**: `ctx.remoteTransfer` copies stream chunk-wise
  without resume; an interrupted copy can leave a partial file on the
  destination side.

## Development

```sh
pnpm install
pnpm build        # all packages, topological order
pnpm test
pnpm typecheck
pnpm verify:contract   # diff vendored seams against the pinned upstream dsh version
```

Integration tests use a throwaway sshd container:

```sh
eval "$(integration/run-sshd.sh start)"   # exports DSH_TEST_SSH_* vars
# ... run integration specs ...
integration/run-sshd.sh stop
```

End-to-end smoke against a real `dsh` host (boots the actual dsh CLI on a
scratch `DSH_HOME`, swaps the fs/subprocess provider rows for ours via a
`--patch` overlay, and exercises them against the sshd container):

```sh
pnpm smoke:dsh-host
```
