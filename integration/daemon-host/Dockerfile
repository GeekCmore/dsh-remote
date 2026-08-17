# Daemon-mode smoke target: the integration/sshd image plus Node + npm, so a
# headless dsh (with @dsh-remote/backend) can run INSIDE the container.
# Build:  docker build -t dsh-remote-test-daemon-host integration/daemon-host
# The public key is injected at runtime via env PUBKEY (see run-sshd.sh,
# parameterized with DSH_SSHD_IMAGE/CONTEXT/CONTAINER/PORT).
FROM alpine:3.21

# nodejs/npm run the headless dsh; python3/make/g++ let node-gyp compile
# node-pty (dsh-base dep) — node-pty ships no musl prebuilds, and dsh
# refuses an install whose build scripts were skipped.
RUN apk add --no-cache openssh bash coreutils grep sed gawk procps nodejs npm \
  python3 make g++ \
  && adduser -D -s /bin/bash dsh \
  && sed -i 's/^dsh:[^:]*/dsh:*/' /etc/shadow \
  && mkdir -p /home/dsh/.ssh /run/sshd \
  && ssh-keygen -A

# Verbatim copy of ../sshd/entrypoint.sh. Keeping a local copy (instead of
# widening the docker build context to integration/) lets run-sshd.sh build
# this image with context = this directory, exactly like integration/sshd.
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 22
ENTRYPOINT ["/entrypoint.sh"]
