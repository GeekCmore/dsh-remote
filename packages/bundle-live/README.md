# @dsh-remote/bundle-live

dsh profile bundle for **live mode**: the local dsh process keeps the session
(agent loop, LLM calls, approvals, session log all stay local) while the
*execution world* — `ctx.fs` and `ctx.subprocess` — is rerouted to a remote
Linux host over SSH. Agentless: the remote host needs only `sshd`, `bash`,
coreutils and procps.

## What the patch does

Applied after `@deepseek-ai/dsh-base` in a profile's bundle stack,
`cordis.patch.yml`:

1. disables the dsh-base rows `fs-sandbox` (`@deepseek-ai/dsh-fs-sandbox`)
   and `subprocess` (`@deepseek-ai/dsh-subprocess-local`) — a patch cannot
   swap a row's plugin `name`, so the local backends are disabled and the
   SSH providers are inserted instead;
2. inserts `remote-ssh` (`ctx.remoteHub`, the ssh2 connection owner) with a
   declarative `targets` list and `autoConnect`;
3. inserts `fs-ssh` (`ctx.fs` over SFTP + exec) and `subprocess-ssh`
   (`ctx.subprocess` over exec wrapper + PTY), wired to the hub through
   their declarative `target` option, which resolves `ctx.remoteHub`
   lazily per call (isolate-safe — no `inject` needed).

## Usage

The bundle composes with any profile layered on `@deepseek-ai/dsh-base`,
including self-built frontend profiles (e.g. a TUI profile assembled from a
community TUI bundle). It touches only the `fs-sandbox`/`subprocess` rows, so
it has no row conflicts with frontend bundles; it just has to apply **after**
dsh-base.

The user-facing install path is `dsh plugin add`, which detects the bundle's
`dsh.bundle.patch` declaration and appends it to `dsh.profile.bundles`:

```sh
dsh plugin --profile <profile> add <tui-bundle>   # if the profile uses one
dsh plugin --profile <profile> add <bundle-live>  # this bundle, after dsh-base
```

`@dsh-remote/bundle-live` is private and unpublished. Pass a `pnpm pack`
tarball (recommended — packing rewrites the `workspace:*` dependency specs),
or a relative path to `packages/bundle-live`; with a bare path you must bind
the `@dsh-remote/*` dependencies yourself (e.g. pnpm `overrides` to local
tarballs, the way `e2e/dsh-host/run-smoke.sh` does).

Alternatively, reference the bundle from a profile manifest
(`$DSH_HOME/profiles/<name>/package.json`):

```json
{
  "dependencies": {
    "@dsh-remote/bundle-live": "<version>"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@dsh-remote/bundle-live"]
    }
  }
}
```

The shipped default target reads its address from the environment
(`DSH_REMOTE_HOST` / `DSH_REMOTE_PORT` / `DSH_REMOTE_USER`, agent auth) under
the id `default`. To pin real hosts, restate the **whole** `remote-ssh` row
config in the profile's own `cordis.patch.yml` (patches replace, never
merge):

```yaml
- id: remote-ssh
  name: '@dsh-remote/remote-ssh'
  config:
    autoConnect: true
    targets:
      - id: default
        ssh:
          host: build.example.com
          username: dsh
          auth: { type: key, privateKeyPath: /home/me/.ssh/id_ed25519 }
```

If you rename the target id, also restate the `fs-ssh` and `subprocess-ssh`
rows — their `target` configs reference the id.

## Caveats

- File mutations (`ctx.fs`) are no longer wrapped by the local sandbox
  policy; permission semantics on the remote host are the SSH account's own.
- The bash tool chain differs: the dsh-base `sandbox`/`sandbox-policy` rows
  stay enabled (bash-sandbox hard-injects them and a missing entry is fatal
  at boot), so bash calls are still confined with the *locally* probed
  sandbox runner — bwrap/landlock argv executed on the remote host. Where the
  remote has no matching runner the bash tool fails closed
  (`SandboxUnavailableError`); `DSH_PERMISSION_MODE=danger-full-access`
  skips confinement but also flips the approval policy to `never` — your
  trade-off. sandbox-policy also injects a "Current DSH file policy"
  paragraph into the system prompt whose wording assumes local semantics.
- Relative paths resolve against the remote cwd; nothing is synced between
  host and remote workspaces.
- Multi-harness races against the same remote file are detected only within
  one process (same stance as upstream `fs-e2b`).

## Frontend notes

Known caveats for dsh-TUI-style in-process frontends:

- Frontends that read `~/.dsh/sessions` JSONL directly via `node:fs` are
  unsupported: in live mode that path stays local while the execution world
  is remote, so the two views diverge. (Same support boundary as
  `docs/frontend-connection-api.md`.)
- Clipboard-image flows that write a local temp file and then insert it into
  the prompt by path will miss on the remote fs. The fix belongs on the
  frontend side (send bytes / use the attachments seam); we only document it
  here.
- Frontends with their own workspace / shell-escape seam (e.g. a
  `/workspace` picker or a `!command` shell route) keep running those
  locally unless they route through the generic seams. This repo stays
  frontend-agnostic on purpose: such a provider is small (register the
  remote target as a workspace; run the shell escape via `ctx.subprocess`)
  and belongs to the frontend's own integration layer, not to this repo.
