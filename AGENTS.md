# dsh-remote — agent notes

SSH remote-control plugins for DeepSeek Harness (dsh). pnpm monorepo, Node
24, TypeScript strict + NodeNext ESM, vitest.

## Commands

```sh
pnpm install
pnpm build        # all packages, topological order (tsc)
pnpm test         # unit tests; integration specs skip without DSH_TEST_SSH_*
pnpm typecheck    # tsc --noEmit everywhere
```

Integration tests run against a throwaway sshd container:

```sh
eval "$(integration/run-sshd.sh start)"   # exports DSH_TEST_SSH_* vars
pnpm --filter @dsh-remote/fs-ssh test
pnpm --filter @dsh-remote/subprocess-ssh test
integration/run-sshd.sh stop
```

## Package index

- `packages/seams` — vendored dsh seam definitions (`ctx.fs`, `ctx.subprocess`), MIT-adapted for standalone compilation
- `packages/remote-core` — wire protocol: newline JSON-RPC 2.0, channel mux, framing, error vocabulary, pairing auth
- `packages/remote` — `ctx.remoteHub` service definition + transport SPI (no runtime deps)
- `packages/remote-ssh` — ssh2-backed `SshRemoteHub` / `SshTransport`
- `packages/fs-ssh` — `ctx.fs` over SFTP + exec (live mode)
- `packages/subprocess-ssh` — `ctx.subprocess` over exec wrapper + PTY (live mode)
- `packages/remote-sessions` — `ctx.remoteSessions` definition (daemon mode)
- `packages/remote-daemon` — `ctx.remoteSessions` over the daemon protocol (frontend)
- `packages/remote-frontend` — transfer/preview, monitor, `remote_copy` tool
- `packages/remote-backend` — daemon-side plugin (broker, approval bridge, lease, monitor, transfer)
- `packages/bundle-live` / `packages/bundle-daemon` — dsh profile bundles (`dsh.bundle` patch in `cordis.patch.yml`, no code)

Design doc: `docs/design.md`. Usage: root `README.md` and each bundle's README.

## Vendored seam discipline (`packages/seams`)

The files under `packages/seams/src` are vendored from
`deepseek-ai/deepseek-harness` (MIT); each header records the upstream path
and version. When touching them:

- keep them **structurally aligned** with upstream — adapt imports only
  where the upstream package cannot be installed standalone (see the
  `sandbox.js` adaptation note in `fs.ts`);
- never add local features to a vendored file — extension points belong in
  the provider packages (`fs-ssh`, `subprocess-ssh`, …);
- when bumping the vendored version, update the `Upstream version:` header in
  every vendored file and re-diff against upstream.

## Conventions

- Public contract changes (e.g. `packages/remote/src/transport.ts`) must keep
  backward compatibility and update the fakes under `packages/*/tests`.
- Bundle patches (`packages/bundle-*/cordis.patch.yml`) are validated against
  the real `@deepseek-ai/dsh-base` patch — a patch can disable a row and
  insert new rows, but cannot change a row's plugin `name` (mismatch = skip
  with warning). Validate changes with `applyEntryPatches` from
  `@deepseek-ai/cordis-plugin-include`.
