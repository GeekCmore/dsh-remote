#!/usr/bin/env bash
# Smoke our daemon-mode stack inside a REAL dsh host, against a REAL headless
# dsh running inside a throwaway container:
#
#   1. install the real dsh CLI locally (cached under .cache/dsh-cli),
#   2. build + pnpm-pack the 9 daemon-mode @dsh-remote/* packages into
#      vendor/,
#   3. boot the daemon-host container (integration/daemon-host via the
#      parameterized integration/run-sshd.sh; port 10023 so it can coexist
#      with the live-mode sshd container on 10022),
#   4. deploy the daemon onto the container over ssh/scp: upload the backend
#      tarball (plus its workspace deps core/seams, unpublished on npm), lay
#      out the remote profile $DSH_HOME/profiles/daemon (dsh-base +
#      dsh-app-boot from npm), npm-install it, and `dsh-remote-backend init`
#      for the pairing token (deploy_remote()),
#   5. OPTIONAL: when an LLM key is present (DSH_SMOKE_LLM_KEY, falling back
#      to DEEPSEEK_API_KEY), inject it into the container's managed credential
#      store ($DSH_HOME/.credentials.yaml) — daemon mode runs the model call
#      on the REMOTE host, so the key must live there; the smoke plugin then
#      exercises real question-bridge and approval-bridge prompt round trips;
#      the OK line gains `llm=ok question=ok approval=ok`. With no key the LLM
#      leg prints one SKIP line. The key
#      travels over ssh stdin only: never argv, never a log line, never
#      smoke.out,
#   6. create a scratch DSH_HOME with a `smoke-daemon` profile layered on
#      @deepseek-ai/dsh-base only (no headless runner → no LOCAL LLM key
#      needed), and install the tarballs into it (the way `dsh plugin` does),
#   7. boot `dsh --profile smoke-daemon --patch smoke.patch.yml` — the overlay
#      swaps the sessions/agents/sessionPersistence rows for the remote-proxy
#      implementations (bundle-daemon-tui rows, key-auth adaptation) and
#      mounts smoke-plugin.mjs, which asserts the mounted services, lists /
#      creates / reads / forks a session on the remote daemon, prints
#      DSH_REMOTE_DAEMON_SMOKE OK and exits 0,
#   8. grep the marker line to decide success.
#
# Caches the dsh CLI install under .cache/; `run-smoke.sh clean` removes all
# generated state and stops the container. Requires: docker, node, npm, pnpm,
# network access to the npm registry (first run only, and on every remote
# deploy — the container installs the dsh CLI itself).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
E2E="$ROOT/e2e/dsh-daemon"
CACHE="$E2E/.cache"
VENDOR="$E2E/vendor"
CLI_DIR="$CACHE/dsh-cli"
DSH_HOME="$CACHE/dsh-home"
PROFILE="smoke-daemon"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
DSH_VERSION="@deepseek-ai/dsh@0.1.0-rc.6"
# <package dir>=<npm name>; the name is not always the directory name
# (remote-core → @dsh-remote/core, remote-sessions → @dsh-remote/sessions,
# remote-proxy → @dsh-remote/proxy, remote-backend → @dsh-remote/backend).
PACKAGES=(seams=@dsh-remote/seams remote-core=@dsh-remote/core remote=@dsh-remote/remote
  remote-ssh=@dsh-remote/remote-ssh remote-client=@dsh-remote/client remote-sessions=@dsh-remote/sessions
  remote-daemon=@dsh-remote/remote-daemon remote-proxy=@dsh-remote/proxy remote-backend=@dsh-remote/backend)

# The daemon-mode container, side by side with the live-mode one (10022).
export DSH_SSHD_IMAGE=dsh-remote-test-daemon-host
export DSH_SSHD_CONTEXT="$ROOT/integration/daemon-host"
export DSH_SSHD_CONTAINER=dsh-remote-test-daemon-host
export DSH_SSHD_PORT=10023

if [ "${1:-}" = "clean" ]; then
  "$ROOT/integration/run-sshd.sh" stop
  rm -rf "$CACHE" "$VENDOR"
  echo "cleaned $CACHE and $VENDOR (and stopped $DSH_SSHD_CONTAINER)"
  exit 0
fi

log() { printf '[smoke-daemon] %s\n' "$*" >&2; }

# --- 1. dsh CLI (local) ------------------------------------------------------
if [ ! -x "$CLI_DIR/node_modules/.bin/dsh" ]; then
  log "installing $DSH_VERSION into $CLI_DIR"
  mkdir -p "$CLI_DIR"
  npm install --prefix "$CLI_DIR" --no-fund --no-audit "$DSH_VERSION" >&2
fi
DSH="$CLI_DIR/node_modules/.bin/dsh"

# --- 2. build + pack our packages --------------------------------------------
rm -rf "$VENDOR"
mkdir -p "$VENDOR"
for entry in "${PACKAGES[@]}"; do
  (cd "$ROOT/packages/${entry%%=*}" && pnpm build >&2 && pnpm pack --pack-destination "$VENDOR" >/dev/null)
done
log "packed: $(ls "$VENDOR" | tr '\n' ' ')"

# --- 3. daemon-host container -------------------------------------------------
eval "$("$ROOT/integration/run-sshd.sh" start)"
trap '"$ROOT/integration/run-sshd.sh" stop' EXIT
log "daemon host: $DSH_TEST_SSH_USER@$DSH_TEST_SSH_HOST:$DSH_TEST_SSH_PORT"

# --- 4. deploy the daemon onto the container ----------------------------------
SSH=(ssh -i "$DSH_TEST_SSH_KEY" -p "$DSH_TEST_SSH_PORT"
  -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null
  "$DSH_TEST_SSH_USER@$DSH_TEST_SSH_HOST")
SCP=(scp -i "$DSH_TEST_SSH_KEY" -P "$DSH_TEST_SSH_PORT"
  -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null)

# Prints the pairing token on stdout (and nothing else); progress goes to
# stderr. The remote layout (A0 boot contract):
#   - profile at $DSH_HOME/profiles/daemon (DSH_HOME defaults to ~/.dsh, so
#     the ssh-exec'd serve needs no env), package.json with dsh-base +
#     dsh-app-boot from npm and @dsh-remote/backend from the uploaded tarball
#     (its workspace deps @dsh-remote/core + @dsh-remote/seams are packed as
#     unpublished 0.0.0 versions, so they ride along as file: tarballs too);
#   - cordis.patch.yml inserts the `@dsh-remote/backend` plugin row that
#     `serve --profile daemon` audits after boot;
#   - `init` runs from the profile's own node_modules/.bin; the pairing token
#     (stdout line 2) is captured by the caller;
#   - the frontend's exec command (backendCommand in smoke.patch.yml) is
#     /home/dsh/.dsh/profiles/daemon/node_modules/.bin/dsh-remote-backend
#     serve --profile daemon.
deploy_remote() {
  log "deploying the daemon stack onto the container"

  # 1. Upload the packed tarballs the remote profile installs.
  "${SSH[@]}" 'mkdir -p "$HOME/vendor"' >&2
  "${SCP[@]}" "$VENDOR/dsh-remote-backend-0.0.0.tgz" "$VENDOR/dsh-remote-core-0.0.0.tgz" \
    "$VENDOR/dsh-remote-seams-0.0.0.tgz" \
    "$DSH_TEST_SSH_USER@$DSH_TEST_SSH_HOST:vendor/" >&2

  # 2. Lay out the remote profile, npm-install it, mint the pairing token.
  #    Everything except the token line goes to stderr.
  "${SSH[@]}" 'bash -s' <<'REMOTE'
set -euo pipefail
PROFILE="$HOME/.dsh/profiles/daemon"
mkdir -p "$PROFILE"
cd "$PROFILE"
cat > package.json <<'JSON'
{
  "name": "dsh-profile-daemon",
  "private": true,
  "dependencies": {
    "@deepseek-ai/dsh-base": "0.1.0-rc.6",
    "@deepseek-ai/dsh-app-boot": "0.1.0-rc.6",
    "@deepseek-ai/dsh-tool-ask-user": "0.1.0-rc.6",
    "@dsh-remote/backend": "file:/home/dsh/vendor/dsh-remote-backend-0.0.0.tgz",
    "@dsh-remote/core": "file:/home/dsh/vendor/dsh-remote-core-0.0.0.tgz",
    "@dsh-remote/seams": "file:/home/dsh/vendor/dsh-remote-seams-0.0.0.tgz"
  },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base"] } }
}
JSON
cat > cordis.patch.yml <<'YAML'
# hmr needs --expose-internals; a daemon exec process is restarted, not
# hot-reloaded (profile-boot mounts no watchers), so disable the base row.
- id: hmr
  name: '@deepseek-ai/cordis-plugin-hmr'
  disabled: true
- insert:
    # The backend's apply() gate-keeps only the REQUIRED services via inject;
    # optional services (sessionPersistence, userQuestions, llm, skills,
    # agentPresets, compaction, attachments) are probed isolate-safely at
    # runtime via ctx.get, so no inject entries (and no stubs for services
    # the profile never provides) are needed here.
    - id: dsh-remote-backend
      name: '@dsh-remote/backend'
      inject: [sessions, agents]
    # dsh-base provides ctx.userQuestions but intentionally does not mount
    # the model-facing ask_user_question tool; the smoke needs the real tool
    # on the remote agent to exercise the backend question adapter.
    - id: tool-ask-user
      name: '@deepseek-ai/dsh-tool-ask-user'
YAML
npm install --no-fund --no-audit --fetch-retries=5 >&2
# Token is stdout line 2 of init (line 1 is the header, line 3 the path note).
# --rotate-token keeps the deploy idempotent across container rebuilds that
# reuse a volume-backed home.
./node_modules/.bin/dsh-remote-backend init --rotate-token | sed -n 2p
REMOTE
}
DSH_REMOTE_TOKEN="$(deploy_remote)"
[ -n "$DSH_REMOTE_TOKEN" ] || { log "deploy_remote() yielded an empty pairing token"; exit 1; }

# --- 4b. optional remote LLM credential ---------------------------------------
# Daemon mode places the model call on the REMOTE host, so the key must be in
# the container's own credential store — dsh-llm-deepseek's default
# `apiKeyEnv: DEEPSEEK_API_KEY` reference resolves through the managed
# $DSH_HOME/.credentials.yaml (the inherited remote environment wins but has
# no key). Piped over ssh stdin with umask 077: the key never touches argv,
# the script text, a log line, or smoke.out. No key → the smoke's LLM leg
# SKIPs (smoke-plugin.mjs applies the same DSH_SMOKE_LLM_KEY →
# DEEPSEEK_API_KEY precedence to decide).
if [ -n "${DSH_SMOKE_LLM_KEY:-${DEEPSEEK_API_KEY:-}}" ]; then
  log "injecting the LLM credential into the container's .credentials.yaml"
  printf 'DEEPSEEK_API_KEY: %s\n' "${DSH_SMOKE_LLM_KEY:-${DEEPSEEK_API_KEY:-}}" | "${SSH[@]}" \
    'umask 077; mkdir -p "$HOME/.dsh" && cat > "$HOME/.dsh/.credentials.yaml"' >&2
fi

# --- 5. scratch DSH_HOME + smoke-daemon profile -------------------------------
rm -rf "$DSH_HOME"
mkdir -p "$PROFILE_DIR"
# The manifest mirrors what `dsh plugin --profile smoke-daemon` would
# initialize, layered on dsh-base only. The overrides do two jobs: re-point
# seams' historical 0.0.1-rc.1 pins (never published) at the published rc.6
# line, and bind every inter-package `@dsh-remote/*@0.0.0` dependency to its
# local tarball (pnpm would otherwise ask the registry for those versions).
{
  cat > "$PROFILE_DIR/pnpm-workspace.yaml" <<'YAML'
packages:
  - .
nodeLinker: hoisted
autoInstallPeers: false
# ssh2's optional native pieces are unnecessary (pure-JS fallback); say so
# explicitly or pnpm 11 fails the install with ERR_PNPM_IGNORED_BUILDS.
allowBuilds:
  ssh2: false
  cpu-features: false
overrides:
  '@deepseek-ai/dsh-brand': 0.1.0-rc.6
  '@deepseek-ai/dsh-llm': 0.1.0-rc.6
YAML
  for entry in "${PACKAGES[@]}"; do
    name="${entry#*=}"
    tgz="$VENDOR/$(echo "${name#@}" | tr '/' '-')-0.0.0.tgz"
    [ -f "$tgz" ] || { log "missing tarball $tgz"; exit 1; }
    printf "  '%s': 'file:%s'\n" "$name" "$tgz" >> "$PROFILE_DIR/pnpm-workspace.yaml"
  done
}
cat > "$PROFILE_DIR/package.json" <<'JSON'
{
  "name": "dsh-profile-smoke-daemon",
  "private": true,
  "dependencies": {},
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base"] } }
}
JSON
printf '[]\n' > "$PROFILE_DIR/cordis.patch.yml"
cp "$E2E/smoke-plugin.mjs" "$PROFILE_DIR/smoke-plugin.mjs"

log "installing vendor tarballs into the profile"
DSH_HOME="$DSH_HOME" "$DSH" plugin --profile "$PROFILE" add "$VENDOR"/*.tgz >&2

# --- 6. boot + judge -----------------------------------------------------------
# DSH_TEST_SSH_* (inherited from the run-sshd.sh eval above) feed the patch's
# !!js ssh target; DSH_REMOTE_TOKEN is the pairing token from deploy_remote().
# DSH_REMOTE_HOST/PORT/USER are restated for parity with the bundle's shipped
# defaults; the smoke patch itself reads DSH_TEST_SSH_*.
OUT="$CACHE/smoke.out"
set +e
DSH_HOME="$DSH_HOME" DSH_TELEMETRY_DISABLED=1 \
  DSH_REMOTE_TOKEN="$DSH_REMOTE_TOKEN" \
  DSH_REMOTE_HOST=127.0.0.1 DSH_REMOTE_PORT=10023 DSH_REMOTE_USER=dsh \
  timeout 600 "$DSH" --profile "$PROFILE" --patch "$E2E/smoke.patch.yml" >"$OUT" 2>&1
code=$?
set -e

if grep -q 'DSH_REMOTE_DAEMON_SMOKE OK' "$OUT"; then
  grep 'DSH_REMOTE_DAEMON_SMOKE OK' "$OUT" >&2
  log "PASS (dsh exit $code; full log: $OUT)"
  exit 0
fi
log "FAIL (dsh exit $code; full log: $OUT)"
grep 'DSH_REMOTE_DAEMON_SMOKE FAIL' "$OUT" >&2 || tail -40 "$OUT" >&2
exit 1
