#!/usr/bin/env bash
# Smoke our live-mode SSH providers inside a REAL dsh host, in two scenarios
# sharing one sshd container and one vendor/ of packed tarballs:
#
#   scenario "patch"  — the hand-written overlay path: a `smoke` profile
#     layered on @deepseek-ai/dsh-base only, provider tarballs installed as
#     plain plugins, and `dsh --patch smoke.patch.yml` swapping the
#     fs-sandbox/subprocess rows. Validates the --patch mechanism.
#
#   scenario "bundle" — the user-facing path: the @dsh-remote/bundle-live
#     tarball is installed into a `smoke-bundle` profile with
#     `dsh plugin add`, which registers its cordis.patch.yml as a profile
#     bundle (the bundle itself disables fs-sandbox/subprocess and inserts
#     the providers). A minimal `--patch smoke.bundle.patch.yml` overlay only
#     re-points the bundle's remote-ssh row at the test container and mounts
#     the smoke plugin — it deliberately does NOT repeat the row disables.
#     Validates the bundle mechanism; a clean boot also proves the kept
#     sandbox/sandbox-policy rows coexist with our providers.
#
# Both scenarios mount smoke-plugin.mjs, which asserts the mounted services
# (constructor names), runs a real readText + echo against the container,
# prints DSH_REMOTE_SMOKE OK and exits 0; we grep the marker to judge.
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
DSH_VERSION="@deepseek-ai/dsh@0.1.0-rc.6"
# <package dir>=<npm name>; the name is not always the directory name
# (remote-core publishes as @dsh-remote/core).
PACKAGES=(seams=@dsh-remote/seams remote=@dsh-remote/remote remote-core=@dsh-remote/core
  remote-ssh=@dsh-remote/remote-ssh fs-ssh=@dsh-remote/fs-ssh subprocess-ssh=@dsh-remote/subprocess-ssh)
BUNDLE_TGZ_NAME=dsh-remote-bundle-live-0.0.0.tgz

if [ "${1:-}" = "clean" ]; then
  rm -rf "$CACHE" "$VENDOR"
  echo "cleaned $CACHE and $VENDOR"
  exit 0
fi

log() { printf '[smoke] %s\n' "$*" >&2; }

tgz_path() { # $1 = npm name → tarball path in vendor/
  echo "$VENDOR/$(echo "${1#@}" | tr '/' '-')-0.0.0.tgz"
}

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
# bundle-live is composition only (no src/, no build); pack it as-is. Packing
# rewrites its workspace:* deps to 0.0.0, which the profile overrides below
# then bind to the local tarballs.
(cd "$ROOT/packages/bundle-live" && pnpm pack --pack-destination "$VENDOR" >/dev/null)
log "packed: $(ls "$VENDOR" | tr '\n' ' ')"

# --- 3. sshd container -------------------------------------------------------
eval "$("$ROOT/integration/run-sshd.sh" start)"
trap '"$ROOT/integration/run-sshd.sh" stop' EXIT
log "sshd: $DSH_TEST_SSH_USER@$DSH_TEST_SSH_HOST:$DSH_TEST_SSH_PORT"

# --- 4. scratch DSH_HOME + profiles -----------------------------------------
rm -rf "$DSH_HOME"

# $1 = profile directory. The manifest workspace mirrors what
# `dsh plugin --profile <name>` would initialize. The overrides do two jobs:
# re-point seams' historical 0.0.1-rc.1 pins (never published) at the
# published rc.6 line, and bind every inter-package `@dsh-remote/*@0.0.0`
# dependency to its local tarball (pnpm would otherwise ask the registry for
# those exact versions).
write_profile_workspace() {
  local dir="$1" entry name tgz
  cat > "$dir/pnpm-workspace.yaml" <<'YAML'
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
    tgz="$(tgz_path "$name")"
    [ -f "$tgz" ] || { log "missing tarball $tgz"; exit 1; }
    printf "  '%s': 'file:%s'\n" "$name" "$tgz" >> "$dir/pnpm-workspace.yaml"
  done
}

# $1 = scenario tag, $2 = profile name, $3 = patch file. Returns nonzero on
# failure so both scenarios always run.
boot_and_judge() {
  local tag="$1" profile="$2" patch="$3"
  local out="$CACHE/smoke.$tag.out" code
  log "[$tag] booting: dsh --profile $profile --patch $patch"
  set +e
  DSH_HOME="$DSH_HOME" DSH_TELEMETRY_DISABLED=1 \
    timeout 180 "$DSH" --profile "$profile" --patch "$patch" >"$out" 2>&1
  code=$?
  set -e
  if grep -q 'DSH_REMOTE_SMOKE OK' "$out"; then
    grep 'DSH_REMOTE_SMOKE OK' "$out" >&2
    log "[$tag] PASS (dsh exit $code; full log: $out)"
    return 0
  fi
  log "[$tag] FAIL (dsh exit $code; full log: $out)"
  grep 'DSH_REMOTE_SMOKE FAIL' "$out" >&2 || tail -40 "$out" >&2
  return 1
}

# --- scenario "patch": hand-written --patch overlay swaps the rows ---------
setup_patch_profile() {
  local dir="$DSH_HOME/profiles/smoke" entry name
  local tgzs=()
  mkdir -p "$dir"
  write_profile_workspace "$dir"
  cat > "$dir/package.json" <<'JSON'
{
  "name": "dsh-profile-smoke",
  "private": true,
  "dependencies": {},
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base"] } }
}
JSON
  printf '[]\n' > "$dir/cordis.patch.yml"
  cp "$E2E/smoke-plugin.mjs" "$dir/smoke-plugin.mjs"
  # Explicit tarball list (not a glob): vendor/ now also holds the
  # bundle-live tarball, which this scenario must NOT install.
  for entry in "${PACKAGES[@]}"; do
    name="${entry#*=}"
    tgzs+=("$(tgz_path "$name")")
  done
  log "[patch] installing provider tarballs into the profile"
  DSH_HOME="$DSH_HOME" "$DSH" plugin --profile smoke add "${tgzs[@]}" >&2
}

# --- scenario "bundle": bundle-live registered via `dsh plugin add` --------
setup_bundle_profile() {
  local dir="$DSH_HOME/profiles/smoke-bundle"
  local tgz="$VENDOR/$BUNDLE_TGZ_NAME"
  mkdir -p "$dir"
  write_profile_workspace "$dir"
  # Layered on dsh-base; `dsh plugin add` below appends bundle-live to
  # dsh.profile.bundles itself (reconcilePlugins picks up the tarball's
  # dsh.bundle.patch declaration) — that registration is what this scenario
  # validates, so it is not written by hand here.
  cat > "$dir/package.json" <<'JSON'
{
  "name": "dsh-profile-smoke-bundle",
  "private": true,
  "dependencies": {},
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base"] } }
}
JSON
  printf '[]\n' > "$dir/cordis.patch.yml"
  cp "$E2E/smoke-plugin.mjs" "$dir/smoke-plugin.mjs"
  [ -f "$tgz" ] || { log "[bundle] missing tarball $tgz"; exit 1; }
  log "[bundle] dsh plugin add $BUNDLE_TGZ_NAME (should register the bundle patch)"
  DSH_HOME="$DSH_HOME" "$DSH" plugin --profile smoke-bundle add "$tgz" >&2
  # Fail loudly if the bundle mechanism did not kick in: the boot below would
  # otherwise fail later with a less pointed constructor-assertion error.
  if ! node -e '
    const p = require(process.argv[1]);
    const bundles = p.dsh?.profile?.bundles ?? [];
    if (!bundles.includes("@dsh-remote/bundle-live")) {
      console.error("dsh.profile.bundles after plugin add:", JSON.stringify(bundles));
      process.exit(1);
    }
  ' "$dir/package.json" >&2; then
    log "[bundle] FAIL: @dsh-remote/bundle-live was not registered into dsh.profile.bundles"
    exit 1
  fi
}

FAILED=0
setup_patch_profile
boot_and_judge patch smoke "$E2E/smoke.patch.yml" || FAILED=1
setup_bundle_profile
boot_and_judge bundle smoke-bundle "$E2E/smoke.bundle.patch.yml" || FAILED=1

if [ "$FAILED" -eq 0 ]; then
  log "ALL SCENARIOS PASS"
else
  log "SMOKE FAILED (see per-scenario logs in $CACHE)"
fi
exit "$FAILED"
