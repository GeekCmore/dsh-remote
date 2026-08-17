# dsh-remote — agent notes

SSH remote-control plugins for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness).
pnpm 11 monorepo, Node 24, TypeScript strict + NodeNext ESM (`"type": "module"`,
relative imports in source use explicit `.js` suffixes), vitest 3.

## What this is

Two modes, both transparent to dsh frontends (CLI/TUI/GUI/SDK):

- **live mode** — the local dsh host keeps the session (agent loop, LLM calls,
  approvals all local); only the *execution world* (`ctx.fs` + `ctx.subprocess`
  capability seams) is rerouted to a remote Linux host. Agentless: SFTP + exec
  channels + a remote bash wrapper; nothing installed remotely.
- **daemon mode** — a full headless dsh runs on the remote host and owns the
  sessions; local frontends attach/detach tmux-style over an SSH exec channel
  speaking newline-framed JSON-RPC 2.0. HMAC challenge-response pairing auth on
  top of SSH auth; unlimited readers, one exclusive in-memory write lease per
  session.

Settled design (protocol, handshake, lease, trade-offs): `docs/design.md`.
Usage: root `README.md` and each bundle's README.

## Commands

```sh
pnpm install
pnpm build        # all packages, topological order (tsc)
pnpm test         # unit tests; SSH integration specs skip without DSH_TEST_SSH_*
pnpm typecheck    # tsc --noEmit everywhere
pnpm verify:contract  # scripts/verify-contract.mjs: diff vendored seams vs the pinned upstream dsh version
```

Integration tests run against a throwaway sshd container (docker required;
Alpine image with key auth, fixtures under `/home/dsh/work/`):

```sh
eval "$(integration/run-sshd.sh start)"   # exports DSH_TEST_SSH_* vars
pnpm --filter @dsh-remote/fs-ssh test
pnpm --filter @dsh-remote/subprocess-ssh test
integration/run-sshd.sh stop
```

End-to-end smoke against a real `dsh` host (packs the packages, boots the dsh
CLI on a scratch `DSH_HOME`, swaps the fs/subprocess provider rows via a
`--patch` overlay, exercises them against the sshd container):

```sh
pnpm smoke:dsh-host        # e2e/dsh-host/run-smoke.sh; needs docker, node, npm, pnpm
```

## Package layout (`packages/*`)

| Directory | Publishes as | Role |
|---|---|---|
| `remote-core` | `@dsh-remote/core` | shared wire vocabulary: newline JSON-RPC 2.0, channel mux, base64 data framing, error codes, pairing auth, capability bits |
| `seams` | `@dsh-remote/seams` | vendored dsh seam definitions (`ctx.fs`, `ctx.subprocess`), MIT-adapted for standalone compilation |
| `remote` | `@dsh-remote/remote` | `ctx.remoteHub` service definition + transport SPI + SSH target vocabulary (no runtime deps) |
| `remote-ssh` | `@dsh-remote/remote-ssh` | ssh2-backed `SshTransport` / `SshRemoteHub`; one SSH connection per target, handed out lazily to the seam providers |
| `fs-ssh` | `@dsh-remote/fs-ssh` | `ctx.fs` over SFTP + exec (live mode) |
| `subprocess-ssh` | `@dsh-remote/subprocess-ssh` | `ctx.subprocess` over exec wrapper + PTY (live mode) |
| `remote-client` | `@dsh-remote/client` | cordis-free daemon client: handshake, reconnect + seq-cursor resume, leases, capabilities, history/fork-at-seq/compact/prompt-blocks, approval + question bridging API |
| `remote-sessions` | `@dsh-remote/sessions` | `ctx.remoteSessions` definition (cordis augmentation + abstract Service); handle types re-exported from `@dsh-remote/client` |
| `remote-daemon` | `@dsh-remote/remote-daemon` | thin cordis adapter: exposes the client as `ctx.remoteSessions`, token config, `remote/sessions-changed` |
| `remote-proxy` | `@dsh-remote/proxy` | remote-backed implementations of the official session seams (`sessions`/`agents`/`sessionPersistence` via real upstream Service classes + remote replay); bridges remote approvals/questions into the local services — daemon-mode transparency for seam-compliant in-process frontends |
| `remote-frontend` | `@dsh-remote/remote-frontend` | transfer/preview (`ctx.remoteTransfer`), monitor (`ctx.remoteMonitor`), `remote_copy` model tool |
| `remote-backend` | `@dsh-remote/backend` | daemon-side Cordis plugin (broker, approval + question bridges, lease, monitor, transfer, history/compact/catalog endpoints) + `dsh-remote-backend` CLI (`init` / `serve`) |
| `bundle-live` / `bundle-daemon` / `bundle-daemon-tui` | `@dsh-remote/bundle-*` | dsh profile bundles — composition only, `cordis.patch.yml`, no code |

Note the npm-name mismatches: `remote-core` → `@dsh-remote/core`,
`remote-sessions` → `@dsh-remote/sessions`, `remote-backend` → `@dsh-remote/backend`.

Dependency flow: `remote-core` and `seams` are leaves; `remote` declares the
hub; `remote-ssh` implements it; `remote-client` consumes `core` + transport
types (cordis-free); `remote-sessions` adds the cordis augmentation over the
client types; `remote-daemon` binds the client to cordis;
`remote-proxy` consumes the client to re-provide the official session seams;
`fs-ssh`/`subprocess-ssh`/`remote-frontend` consume hub + seams;
`remote-backend` consumes `core` + `seams`; bundles compose providers.
`@deepseek-ai/cordis` is a peer dependency everywhere (supplied by the dsh
host); `remote-proxy` additionally peers on the upstream `dsh-session` /
`dsh-agent` / `dsh-session-persistence` / `dsh-user-approval` /
`dsh-user-questions` definition packages (real Service classes, supplied by
the host).

Protocol evolution: the daemon wire is **additive only** — new methods,
optional fields, capability bits in the handshake (`Capabilities` in
`remote-core/src/auth.ts`); never removals or renames; `SessionEvent` payloads
pass through verbatim. `remote-core/tests/protocol.spec.ts` golden-tests
every literal — extend it for every addition. Support boundary: only
frontends consuming the official dsh seams are supported.

## Conventions

- Each package: `src/` → `tsc -p tsconfig.json` → `dist/` (declaration +
  sourcemaps on), tests in `tests/` run by vitest (`tests/**/*.spec.ts`,
  20s timeout). `remote-backend` typechecks tests too via `tsconfig.test.json`.
- Public contract changes (e.g. `packages/remote/src/transport.ts`) must keep
  backward compatibility and update the fakes under `packages/*/tests`
  (`fake-transport.ts`, `fake-hub.ts`, `fake-backend.ts`, `fake-ssh2.ts`).
- Real-stack e2e tests live next to unit tests: `remote-daemon/tests/e2e`
  runs the real frontend stack against the real `BackendServer` over in-memory
  byte pipes; `fs-ssh`/`subprocess-ssh` `tests/integration` run against the
  sshd container and skip cleanly without `DSH_TEST_SSH_HOST`.
- Bundle patches (`packages/bundle-*/cordis.patch.yml`) are id-targeted
  against `@deepseek-ai/dsh-base` rows: a patch replaces a row's whole
  `config`/flags but **cannot change the row's plugin `name`** (mismatch =
  skip with warning), so swapping a provider means disabling the base row and
  inserting a new one. `!!js` closures evaluate against the entry's cordis
  context and resolve services lazily. Validate changes with
  `pnpm smoke:dsh-host`, which applies the same patch mechanics against the
  real dsh host.

## Vendored seam discipline (`packages/seams`)

The files under `packages/seams/src` are vendored from
`deepseek-ai/deepseek-harness` (MIT); each header records the upstream path
and version. The pin lives in `packages/seams/UPSTREAM.json` (version +
release commit + per-file upstream paths + documented import adaptations);
`pnpm verify:contract` re-fetches upstream at the pin and fails on drift
(rc.6 was verified no-drift against the rc.5 pin — see the note in
UPSTREAM.json). When touching them:

- keep them **structurally aligned** with upstream — adapt imports only where
  the upstream package cannot be installed standalone (see the `sandbox.js`
  adaptation note in `fs.ts`);
- never add local features to a vendored file — extension points belong in the
  provider packages (`fs-ssh`, `subprocess-ssh`, …);
- when bumping the vendored version, update `UPSTREAM.json` and the
  `Upstream version:` header in every vendored file, and re-diff against
  upstream (`pnpm verify:contract`).

## Remote target requirements

Both modes expect a **Linux** remote with `sshd`, `bash`, GNU coreutils
(`realpath -mz`, `stat -c`, `base64`, `ln -T`, …) and procps (`ps` with
`-o tpgid=,stat=` / `-eo sid=,pgid=,stat=`). Daemon mode additionally needs
Node + a headless dsh profile with `@dsh-remote/backend` installed
(`dsh-remote-backend init` sets this up and issues the pairing token).

## Security considerations

- No TCP listener: the daemon channel is an SSH exec process; the attack
  surface is SSH itself. SSH authenticates machine access, the pairing token
  (HMAC challenge-response inside `hello`, never on the wire) authenticates
  the frontend. Keep the two credential sets separate.
- Remote runtime root (`$HOME/.cache/dsh-remote/<hex>`) is mode `0700`, but
  this is same-UID confinement only — processes running as the same remote
  user (or root) can read private control state.
- Live mode replaces the local sandbox backend: permission semantics on the
  remote host are the SSH account's own, not the dsh sandbox policy.
- Known limitations (mtime-granular version guards, TOCTOU on guarded
  publish, async PID, heuristic PTY `inputWaiting`, non-atomic transfers) are
  documented in the root `README.md` — don't "fix" them silently; they are
  acknowledged design trade-offs.
