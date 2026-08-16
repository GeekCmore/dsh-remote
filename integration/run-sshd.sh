#!/usr/bin/env bash
# Spin up a throwaway sshd container for integration tests and print the
# connection parameters as JSON on stdout. Usage:
#   eval "$(integration/run-sshd.sh start)"   # exports DSH_TEST_SSH_* vars
#   integration/run-sshd.sh stop
set -euo pipefail

IMAGE=dsh-remote-test-sshd
CONTAINER=dsh-remote-test-sshd
KEY_DIR="$(cd "$(dirname "$0")" && pwd)/.keys"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

case "${1:-}" in
  start)
    mkdir -p "$KEY_DIR"
    if [ ! -f "$KEY_DIR/id_ed25519" ]; then
      ssh-keygen -t ed25519 -N '' -f "$KEY_DIR/id_ed25519" -C dsh-remote-test >/dev/null
    fi
    docker build -q -t "$IMAGE" "$ROOT/integration/sshd" >/dev/null
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    PORT=10022
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
