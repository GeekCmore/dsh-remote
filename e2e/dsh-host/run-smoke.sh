#!/usr/bin/env bash
# Smoke our live-mode SSH providers inside a REAL dsh host:
#
#   1. build + pnpm-pack the @dsh-remote/* packages into vendor/,
#   2. boot the throwaway sshd container (integration/run-sshd.sh),
#   3. create a scratch DSH_HOME with a `smoke` profile layered on
#      @deepseek-ai/dsh-base only (no headless runner → no LLM key needed),
#   4. install the tarballs into the profile (the way `dsh plugin` does),
#   5. boot `dsh --profile smoke --patch smoke.patch.yml` — the overlay swaps
#      the fs-sandbox/subprocess rows for our providers and mounts
#      smoke-plugin.mjs, which asserts the mounted services, runs a real
#      readText + echo against the container, prints DSH_REMOTE_SMOKE OK and
#      exits 0,
#   6. grep the marker line to decide success.
#
# Caches the dsh CLI install under .cache/; `run-smoke.sh clean` removes all
# generated state. Requires: docker, node, npm, pnpm, network access to the
# npm registry (first run only, for the dsh CLI and ssh2/dsh-llm deps).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
E2E="$ROOT/e2e/dsh-host"
CACHE="$E2E/.cache"
VENDOR="$E2E/vendor"
CLI_DIR="$CACHE/dsh-cli"
DSH_HOME="$CACHE/dsh-home"
PROFILE_DIR="$DSH_HOME/profiles/smoke"
DSH_VERSION="@deepseek-ai/dsh@0.1.0-rc.6"
# <package dir>=<npm name>; the name is not always the directory name
# (remote-core publishes as @dsh-remote/core).
PACKAGES=(seams=@dsh-remote/seams remote=@dsh-remote/remote remote-core=@dsh-remote/core
  remote-ssh=@dsh-remote/remote-ssh fs-ssh=@dsh-remote/fs-ssh subprocess-ssh=@dsh-remote/subprocess-ssh)

if [ "${1:-}" = "clean" ]; then
  rm -rf "$CACHE" "$VENDOR"
  echo "cleaned $CACHE and $VENDOR"
  exit 0
fi

log() { printf '[smoke] %s\n' "$*" >&2; }

# --- 1. dsh CLI -------------------------------------------------------------
if [ ! -x "$CLI_DIR/node_modules/.bin/dsh" ]; then
  log "installing $DSH_VERSION into $CLI_DIR"
  mkdir -p "$CLI_DIR"
  npm install --prefix "$CLI_DIR" --no-fund --no-audit "$DSH_VERSION" >&2
fi
DSH="$CLI_DIR/node_modules/.bin/dsh"

# --- 2. build + pack our packages -------------------------------------------
rm -rf "$VENDOR"
mkdir -p "$VENDOR"
for entry in "${PACKAGES[@]}"; do
  (cd "$ROOT/packages/${entry%%=*}" && pnpm build >&2 && pnpm pack --pack-destination "$VENDOR" >/dev/null)
done
log "packed: $(ls "$VENDOR" | tr '\n' ' ')"

# --- 3. sshd container -------------------------------------------------------
eval "$("$ROOT/integration/run-sshd.sh" start)"
trap '"$ROOT/integration/run-sshd.sh" stop' EXIT
log "sshd: $DSH_TEST_SSH_USER@$DSH_TEST_SSH_HOST:$DSH_TEST_SSH_PORT"

# --- 4. scratch DSH_HOME + smoke profile ------------------------------------
rm -rf "$DSH_HOME"
mkdir -p "$PROFILE_DIR"
# The manifest mirrors what `dsh plugin --profile smoke` would initialize,
# layered on dsh-base only. The overrides do two jobs: re-point seams'
# historical 0.0.1-rc.1 pins (never published) at the published rc.6 line, and
# bind every inter-package `@dsh-remote/*@0.0.0` dependency to its local
# tarball (pnpm would otherwise ask the registry for those exact versions).
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
    dir="${entry%%=*}"
    name="${entry#*=}"
    tgz="$VENDOR/$(echo "${name#@}" | tr '/' '-')-0.0.0.tgz"
    [ -f "$tgz" ] || { log "missing tarball $tgz"; exit 1; }
    printf "  '%s': 'file:%s'\n" "$name" "$tgz" >> "$PROFILE_DIR/pnpm-workspace.yaml"
  done
}
cat > "$PROFILE_DIR/package.json" <<'JSON'
{
  "name": "dsh-profile-smoke",
  "private": true,
  "dependencies": {},
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base"] } }
}
JSON
printf '[]\n' > "$PROFILE_DIR/cordis.patch.yml"
cp "$E2E/smoke-plugin.mjs" "$PROFILE_DIR/smoke-plugin.mjs"

log "installing vendor tarballs into the profile"
DSH_HOME="$DSH_HOME" "$DSH" plugin --profile smoke add "$VENDOR"/*.tgz >&2

# --- 5. boot + judge ---------------------------------------------------------
OUT="$CACHE/smoke.out"
set +e
DSH_HOME="$DSH_HOME" DSH_TELEMETRY_DISABLED=1 \
  timeout 180 "$DSH" --profile smoke --patch "$E2E/smoke.patch.yml" >"$OUT" 2>&1
code=$?
set -e

if grep -q 'DSH_REMOTE_SMOKE OK' "$OUT"; then
  grep 'DSH_REMOTE_SMOKE OK' "$OUT" >&2
  log "PASS (dsh exit $code; full log: $OUT)"
  exit 0
fi
log "FAIL (dsh exit $code; full log: $OUT)"
grep 'DSH_REMOTE_SMOKE FAIL' "$OUT" >&2 || tail -40 "$OUT" >&2
exit 1
