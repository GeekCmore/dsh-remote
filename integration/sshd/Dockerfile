# Minimal sshd target for dsh-remote integration tests.
# Build:  docker build -t dsh-remote-test-sshd integration/sshd
# The public key is injected at runtime via env PUBKEY (see run-sshd.sh).
FROM alpine:3.21

RUN apk add --no-cache openssh bash coreutils grep sed gawk procps \
  && adduser -D -s /bin/bash dsh \
  && sed -i 's/^dsh:[^:]*/dsh:*/' /etc/shadow \
  && mkdir -p /home/dsh/.ssh /run/sshd \
  && ssh-keygen -A

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 22
ENTRYPOINT ["/entrypoint.sh"]
