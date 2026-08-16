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
   `!!js` closures that resolve `ctx.remoteHub` lazily.

## Usage

Reference the bundle from a profile manifest
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
rows — their `getTransport`/`runtimeRoot` closures reference the id.

## Caveats

- The local sandbox policy no longer wraps file mutations; permission
  semantics on the remote host are the SSH account's own.
- Relative paths resolve against the remote cwd; nothing is synced between
  host and remote workspaces.
- Multi-harness races against the same remote file are detected only within
  one process (same stance as upstream `fs-e2b`).
