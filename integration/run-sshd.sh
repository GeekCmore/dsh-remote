#!/usr/bin/env bash
# Spin up a throwaway sshd container for integration tests and print the
# connection parameters as JSON on stdout. Usage:
#   eval "$(integration/run-sshd.sh start)"   # exports DSH_TEST_SSH_* vars
#   integration/run-sshd.sh stop
#
# Image, build context, container name and host port are overridable via
# DSH_SSHD_IMAGE / DSH_SSHD_CONTEXT / DSH_SSHD_CONTAINER / DSH_SSHD_PORT so
# the daemon-mode smoke (e2e/dsh-daemon) can boot its own container
# (integration/daemon-host) alongside this one. The defaults below reproduce
# the original behavior exactly — fs-ssh/subprocess-ssh integration tests
# depend on it.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEY_DIR="$(cd "$(dirname "$0")" && pwd)/.keys"
IMAGE="${DSH_SSHD_IMAGE:-dsh-remote-test-sshd}"
CONTAINER="${DSH_SSHD_CONTAINER:-dsh-remote-test-sshd}"
CONTEXT="${DSH_SSHD_CONTEXT:-$ROOT/integration/sshd}"
PORT="${DSH_SSHD_PORT:-10022}"

case "${1:-}" in
  start)
    mkdir -p "$KEY_DIR"
    if [ ! -f "$KEY_DIR/id_ed25519" ]; then
      ssh-keygen -t ed25519 -N '' -f "$KEY_DIR/id_ed25519" -C dsh-remote-test >/dev/null
    fi
    docker build -q -t "$IMAGE" "$CONTEXT" >/dev/null
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    docker run -d --name "$CONTAINER" -p "127.0.0.1:${PORT}:22" \
      -e "PUBKEY=$(cat "$KEY_DIR/id_ed25519.pub")" "$IMAGE" >/dev/null
    # wait for sshd to accept connections
    for _ in $(seq 1 50); do
      if docker logs "$CONTAINER" 2>&1 | grep -q 'Server listening'; then break; fi
      sleep 0.2
    done
    cat <<EOF
export DSH_TEST_SSH_HOST=127.0.0.1
export DSH_TEST_SSH_PORT=$PORT
export DSH_TEST_SSH_USER=dsh
export DSH_TEST_SSH_KEY=$KEY_DIR/id_ed25519
export DSH_TEST_CONTAINER=$CONTAINER
EOF
    ;;
  stop)
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    ;;
  *)
    echo "usage: $0 start|stop" >&2
    exit 2
    ;;
esac
