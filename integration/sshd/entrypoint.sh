#!/bin/sh
set -eu

: "${PUBKEY:?PUBKEY env (authorized_keys content) is required}"
echo "$PUBKEY" > /home/dsh/.ssh/authorized_keys
chown -R dsh:dsh /home/dsh/.ssh
chmod 700 /home/dsh/.ssh
chmod 600 /home/dsh/.ssh/authorized_keys

# Test fixtures: a workspace with text/binary files for fs provider tests.
mkdir -p /home/dsh/work/sub
printf 'hello remote\nsecond line\n' > /home/dsh/work/hello.txt
printf 'line1\r\nline2\r\n' > /home/dsh/work/crlf.txt
printf 'a\0b' > /home/dsh/work/bin.dat
head -c 262144 /dev/urandom > /home/dsh/work/large.bin
ln -s hello.txt /home/dsh/work/link.txt
chown -R dsh:dsh /home/dsh/work

exec /usr/sbin/sshd -D -e
