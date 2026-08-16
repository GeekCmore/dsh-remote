# @dsh-remote/bundle-daemon

dsh profile bundle for **daemon mode** (frontend side): the local dsh
attaches to sessions running inside a full headless dsh on a remote Linux
host — tmux-style attach/detach, seq-cursor resume after reconnect, and an
exclusive-write control lease per session (read concurrency unlimited).

The remote half is `@dsh-remote/remote-backend`, deployed once per target
with `dsh-remote-backend init` (installs the backend plugin into the remote
headless profile and issues the 256-bit pairing token). The daemon channel
runs as an SSH exec process (`dsh-remote-backend serve`) speaking newline
JSON-RPC on stdio with an HMAC challenge-response handshake — no TCP port is
opened on the remote host.

## What the patch does

Unlike bundle-live, this layer leaves the local execution world alone; it
only **inserts** three rows after `@deepseek-ai/dsh-base`:

1. `remote-ssh` — `ctx.remoteHub`, the ssh2 connection owner. Each daemon
   target carries a `pairingTokenRef`.
2. `remote-daemon` — `ctx.remoteSessions`: list/attach/prompt/cancel/fork
   over the daemon protocol. Its `resolveToken` maps a target's
   `pairingTokenRef` to the token; the shipped default treats the ref as the
   name of an environment variable.
3. `remote-frontend` — `ctx.remoteTransfer` (local↔remote copy + preview),
   `ctx.remoteMonitor` (periodic read-only probes), and the `remote_copy`
   model tool.

## Usage

Reference the bundle from a profile manifest:

```json
{
  "dependencies": {
    "@dsh-remote/bundle-daemon": "<version>"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@dsh-remote/bundle-daemon"]
    }
  }
}
```

Then, per target:

1. On the remote host: `dsh-remote-backend init` — prints the pairing token
   once.
2. Locally: export the token under the ref name (default
   `DSH_REMOTE_TOKEN`) and point the target at the host by restating the
   **whole** `remote-ssh` row config in the profile's `cordis.patch.yml`:

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

## Caveats

- Consumers that need a synchronous PID (e.g. ACP subagents) are not
  supported against daemon targets; the daemon protocol is event-based.
- The pairing token never goes on the wire; SSH authenticates machine access,
  the token authenticates the frontend. Rotate with
  `dsh-remote-backend init --rotate-token` on the remote host.
