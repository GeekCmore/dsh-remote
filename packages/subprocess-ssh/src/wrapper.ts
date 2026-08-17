/**
 * Remote bash wrapper layer for the SSH subprocess provider: script templates,
 * the stdin header codec, and the channel frame vocabulary.
 *
 * Everything here is plain bash + coreutils — zero installation on the remote
 * host. Process-group isolation uses bash monitor mode (`set -m`): each job
 * runs in its own process group whose pgid equals the job leader's pid, so no
 * `setsid` dependency is required.
 *
 * === Channel protocol (spawn) ===
 *
 * Invocation: `bash -c '<SPAWN_WRAPPER>' 'dsh-ssh-spawn' '<id>' '<runtimeRoot>'`.
 *
 * stdin header (before any child stdin bytes; bash `read` consumes a pipe one
 * byte at a time, so the remainder of fd 0 flows to the child untouched):
 *   1. literal `DSHSSH1`
 *   2. base64(NUL-joined argv)
 *   3. base64(NUL-joined `name=value` environment entries)
 *   4. base64(cwd)
 *   5. `ignore` | `-`   (stdin disposition; `pipe`/`{data}` both use fd 0)
 *   6. stdout spill cap in bytes, decimal, or `-`
 *   7. stderr spill cap in bytes, decimal, or `-`
 *   8. literal `END`
 *
 * Channel stdout frames (newline-delimited; control lines start with `!`,
 * which is outside the base64 alphabet, and are only ever emitted while no
 * base64 encoder is running, so frame bytes can never interleave):
 *   - base64 lines: the child's raw stdout stream (GNU `base64` 76-column
 *     wrapping; every line decodes independently, concatenation restores the
 *     byte stream)
 *   - `!DSHSSH FAIL <base64(message)>` — setup failure, wrapper exits 125
 *   - `!DSHSSH START <pgid>` — child launched; real process-group id
 *   - `!DSHSSH END exit:<n>` / `!DSHSSH END signal:<SIGNAME>` — child closed
 *     and both output encoders flushed (emitted after `wait`)
 *
 * Channel stderr: base64 lines = the child's raw stderr stream. Raw non-base64
 * lines before START are wrapper diagnostics (e.g. `env: 'x': No such file`),
 * collected locally for spawn-failure error messages.
 *
 * Remote state files under `<runtimeRoot>/processes/<id>/` (dir mode 0700):
 *   - `pgid`        decimal process-group id
 *   - `status`      `exit:<n>` or `signal:<SIGNAME>` (written before the
 *                   encoder drain, so liveness polls see exit promptly)
 *   - `environment` transient NUL-joined env (deleted by the inner wrapper)
 *   - `stdout.spill` / `stderr.spill`  bounded full-stream spill (only when
 *     the spec's collect mode enables spilling; `head -c <cap>` truncation)
 *   - `*.fifo`        transient encoder plumbing (removed before END; frame
 *                     encoders are FIFO-fed background jobs, not process
 *                     substitutions, because bash's `wait` skips those and
 *                     END would overtake buffered frame bytes)
 *
 * === Terminal protocol ===
 *
 * Setup exec (`TERMINAL_SETUP_SCRIPT` shape, see terminal.ts) writes
 * `<runtimeRoot>/terminals/<id>/{argv,environment,cwd,marker}` (mode 0600).
 * The PTY wrapper reads + deletes them, publishes `pid` and `tty`, prints the
 * random marker byte string, then `exec env -i … argv` so the requested
 * program becomes the session leader on the PTY. Terminal output is raw PTY
 * bytes — no framing; the local side discards everything up to the marker.
 *
 * === Fake simulation contract (tests/fake-transport.ts must model) ===
 *
 *  1. Header: read lines until `END`; base64-decode fields in the fixed order.
 *  2. Spawn wrapper: publish `pgid` file + `!DSHSSH START`; run the program
 *     with the decoded argv/env/cwd; tee each stream to its spill file
 *     (capped) AND base64-frame it (stdout→channel stdout, stderr→channel
 *     stderr); on exit write `status` then emit `!DSHSSH END <status>`.
 *  3. `kill -TERM|-KILL|-0 -<pgid>` delivers to the whole group (a program
 *     that did not trap TERM dies with `signal:SIGTERM`; KILL always dies
 *     with `signal:SIGKILL`); `kill -0 -<pgid>` probes group liveness.
 *  4. `cat -- '<path>'`, `rm -f/rm -rf`, `test -x '<p>'`,
 *     `command -v -- '<name>'` (PATH from exec opts.env), `mkdir+chmod`.
 *  5. Terminal setup script + PTY wrapper: marker echo, `pid`/`tty` files,
 *     foreground-group `ps` output, signal delivery to the foreground group.
 */

/** Single-quote a string for POSIX sh. */
export function sq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

/** Marker line identifying the spawn wrapper to the test fake. */
export const SPAWN_WRAPPER_MARKER = '# dsh-ssh-spawn-wrapper v1';
/** Marker line identifying the terminal wrapper to the test fake. */
export const TERMINAL_WRAPPER_MARKER = '# dsh-ssh-terminal-wrapper v1';
/** Marker line identifying the terminal setup script to the test fake. */
export const TERMINAL_SETUP_MARKER = '# dsh-ssh-terminal-setup v1';

/** Header magic (first stdin line). */
export const HEADER_MAGIC = 'DSHSSH1';

/**
 * The inner spawn script: publishes its job's process group, runs the child
 * under bash monitor mode with split spill/frame output pipelines, then
 * publishes the exit status and the END frame after the encoders drain.
 * Kept as a separate template so the outer wrapper can pass it to
 * `bash -c` with the decoded argv as positional parameters.
 */
const SPAWN_INNER = `# dsh-ssh-spawn-inner v2
set +e
dsh_dir=$1
dsh_outspill=$2
dsh_errspill=$3
dsh_stdin=$4
shift 4
dsh_fail() {
  printf '!DSHSSH FAIL %s\\n' "$(printf '%s' "$1" | base64 | tr -d '\\n')"
  exit 125
}
mapfile -d '' -t dsh_env < "$dsh_dir/environment" || dsh_fail "cannot read environment"
rm -f -- "$dsh_dir/environment"
# The frame encoders must be FIFO-fed background jobs, NOT >(...) process
# substitutions: bash's \`wait\` (even with set -m, even with no arguments)
# does not wait for process substitutions, so END could overtake buffered
# frame bytes and interleave mid-line. Explicit job pids restore the drain
# guarantee — END is emitted only after every encoder hit FIFO EOF.
mkfifo -m 600 -- "$dsh_dir/out.fifo" "$dsh_dir/err.fifo" || dsh_fail "cannot create output fifos"
dsh_wait_pids=""
if [ "$dsh_outspill" != "-" ]; then
  mkfifo -m 600 -- "$dsh_dir/out.spillfifo" || dsh_fail "cannot create stdout spill fifo"
  head -c "$dsh_outspill" < "$dsh_dir/out.spillfifo" > "$dsh_dir/stdout.spill" &
  dsh_wait_pids="$dsh_wait_pids $!"
  # tee survives the capped spill reader exiting early (SIGPIPE on a pipe
  # output is ignored by default: --output-error=warn-nopipe).
  tee "$dsh_dir/out.spillfifo" < "$dsh_dir/out.fifo" | base64 &
else
  base64 < "$dsh_dir/out.fifo" &
fi
dsh_wait_pids="$dsh_wait_pids $!"
if [ "$dsh_errspill" != "-" ]; then
  mkfifo -m 600 -- "$dsh_dir/err.spillfifo" || dsh_fail "cannot create stderr spill fifo"
  head -c "$dsh_errspill" < "$dsh_dir/err.spillfifo" > "$dsh_dir/stderr.spill" &
  dsh_wait_pids="$dsh_wait_pids $!"
  tee "$dsh_dir/err.spillfifo" < "$dsh_dir/err.fifo" | base64 >&2 &
else
  base64 < "$dsh_dir/err.fifo" >&2 &
fi
dsh_wait_pids="$dsh_wait_pids $!"
set -m
if [ "$dsh_stdin" = "ignore" ]; then
  env -i -- "\${dsh_env[@]}" "$@" > "$dsh_dir/out.fifo" 2> "$dsh_dir/err.fifo" < /dev/null &
else
  env -i -- "\${dsh_env[@]}" "$@" > "$dsh_dir/out.fifo" 2> "$dsh_dir/err.fifo" &
fi
dsh_child=$!
printf '%s\\n' "$dsh_child" > "$dsh_dir/pgid" || dsh_fail "cannot publish pgid"
printf '!DSHSSH START %s\\n' "$dsh_child"
wait "$dsh_child"
dsh_status=$?
dsh_status_text=""
if [ "$dsh_status" -gt 128 ] 2>/dev/null; then
  dsh_signame=$(kill -l $((dsh_status - 128)) 2>/dev/null)
  dsh_signame=\${dsh_signame#SIG}
  case "$dsh_signame" in
    ""|*[!A-Z0-9]*) dsh_status_text="exit:$dsh_status" ;;
    *) dsh_status_text="signal:SIG$dsh_signame" ;;
  esac
else
  dsh_status_text="exit:$dsh_status"
fi
printf '%s\\n' "$dsh_status_text" > "$dsh_dir/status"
# Drain the frame encoders (FIFO EOF after the child closed its descriptors)
# before publishing END.
wait $dsh_wait_pids
rm -f -- "$dsh_dir/out.fifo" "$dsh_dir/err.fifo" "$dsh_dir/out.spillfifo" "$dsh_dir/err.spillfifo"
printf '!DSHSSH END %s\\n' "$dsh_status_text"
exit "$dsh_status"
`;

/**
 * The outer spawn script: validates tools, creates the state directory, reads
 * the stdin header (argv never touches a shell command line), decodes the
 * environment into a transient 0600 file, and hands off to the inner script.
 */
export const SPAWN_WRAPPER = `${SPAWN_WRAPPER_MARKER}
set +e
dsh_fail() {
  printf '!DSHSSH FAIL %s\\n' "$(printf '%s' "$1" | base64 | tr -d '\\n')"
  exit 125
}
for dsh_tool in bash base64 tr mkdir chmod env rm kill head tee mkfifo; do
  command -v "$dsh_tool" >/dev/null 2>&1 || dsh_fail "missing required tool: $dsh_tool"
done
dsh_id=$1
dsh_root=$2
dsh_dir="$dsh_root/processes/$dsh_id"
mkdir -p -- "$dsh_dir" 2>/dev/null || dsh_fail "cannot create state directory: $dsh_dir"
chmod 700 -- "$dsh_dir" 2>/dev/null
dsh_readline() { IFS= read -r dsh_h || dsh_fail "truncated header"; }
dsh_readline
[ "$dsh_h" = "${HEADER_MAGIC}" ] || dsh_fail "bad header magic"
dsh_readline; dsh_h_argv=$dsh_h
dsh_readline; dsh_h_env=$dsh_h
dsh_readline; dsh_h_cwd=$dsh_h
dsh_readline; dsh_h_stdin=$dsh_h
dsh_readline; dsh_h_outspill=$dsh_h
dsh_readline; dsh_h_errspill=$dsh_h
dsh_readline
[ "$dsh_h" = "END" ] || dsh_fail "bad header terminator"
case "$dsh_h_stdin" in
  ignore|-) ;;
  *) dsh_fail "bad stdin mode" ;;
esac
printf '%s' "$dsh_h_env" | base64 -d > "$dsh_dir/environment" 2>/dev/null || dsh_fail "bad environment encoding"
chmod 600 -- "$dsh_dir/environment" 2>/dev/null
mapfile -d '' -t dsh_argv < <(printf '%s' "$dsh_h_argv" | base64 -d 2>/dev/null)
[ "\${#dsh_argv[@]}" -ge 1 ] || dsh_fail "empty argv"
dsh_cwd=$(printf '%s' "$dsh_h_cwd" | base64 -d 2>/dev/null)
[ -n "$dsh_cwd" ] || dsh_fail "bad cwd encoding"
cd -- "$dsh_cwd" 2>/dev/null || dsh_fail "cannot chdir: $dsh_cwd"
exec bash -c ${sq(SPAWN_INNER)} dsh-ssh-inner "$dsh_dir" "$dsh_h_outspill" "$dsh_h_errspill" "$dsh_h_stdin" "\${dsh_argv[@]}"
`;

/**
 * The PTY wrapper: consumes the private setup files, publishes identity, then
 * execs the requested argv so it becomes the session leader on the PTY.
 */
export const TERMINAL_WRAPPER = `${TERMINAL_WRAPPER_MARKER}
set +e
dsh_id=$1
dsh_root=$2
dsh_dir="$dsh_root/terminals/$dsh_id"
dsh_fail() {
  printf '%s\n' "$1" > "$dsh_dir/error" 2>/dev/null
  exit 125
}
mapfile -d '' -t dsh_argv < "$dsh_dir/argv" || dsh_fail 'cannot read argv setup'
mapfile -d '' -t dsh_env < "$dsh_dir/environment" || dsh_fail 'cannot read environment setup'
dsh_cwd=$(cat "$dsh_dir/cwd") || dsh_fail 'cannot read cwd setup'
dsh_marker=$(cat "$dsh_dir/marker") || dsh_fail 'cannot read marker setup'
rm -f -- "$dsh_dir/argv" "$dsh_dir/environment" "$dsh_dir/cwd" "$dsh_dir/marker"
[ "\${#dsh_argv[@]}" -ge 1 ] || dsh_fail 'empty argv setup'
printf '%s\\n' "$$" > "$dsh_dir/pid" || dsh_fail 'cannot publish pid'
dsh_tty=$(tty 2>/dev/null)
[ -n "$dsh_tty" ] || dsh_fail 'cannot determine tty'
printf '%s\\n' "\${dsh_tty#/dev/}" > "$dsh_dir/tty" || dsh_fail 'cannot publish tty'
cd -- "$dsh_cwd" 2>/dev/null || dsh_fail "cannot chdir: $dsh_cwd"
printf '%s' "$dsh_marker"
exec env -i -- "\${dsh_env[@]}" "\${dsh_argv[@]}"
`;

/** Build the exec-channel command line for one spawn. */
export function buildSpawnCommand(id: string, runtimeRoot: string): string {
  return `bash -c ${sq(SPAWN_WRAPPER)} dsh-ssh-spawn ${sq(id)} ${sq(runtimeRoot)}`;
}

/** Build the exec-channel command line for one terminal (use with `pty: true`). */
export function buildTerminalCommand(id: string, runtimeRoot: string): string {
  return `bash -c ${sq(TERMINAL_WRAPPER)} dsh-ssh-terminal ${sq(id)} ${sq(runtimeRoot)}`;
}

/**
 * Build the one-shot terminal setup script: creates the private state
 * directory and writes argv/environment/cwd/marker as base64-decoded 0600
 * files. NUL-joins keep argv and env free of any shell interpretation.
 */
export function buildTerminalSetupScript(
  dir: string,
  files: { argv: string[]; env: string[]; cwd: string; marker: string },
): string {
  const write = (name: string, payload: string): string =>
    `printf '%s' ${sq(b64(payload))} | base64 -d > "$dsh_dir/${name}" || exit 125`;
  return `${TERMINAL_SETUP_MARKER}
set -e
dsh_dir=${sq(dir)}
umask 077
mkdir -p -- "$dsh_dir" && chmod 700 -- "$dsh_dir" || exit 125
${write('argv', files.argv.map((a) => `${a}\0`).join(''))}
${write('environment', files.env.map((e) => `${e}\0`).join(''))}
${write('cwd', files.cwd)}
${write('marker', files.marker)}
chmod 600 -- "$dsh_dir/argv" "$dsh_dir/environment" "$dsh_dir/cwd" "$dsh_dir/marker"
`;
}

/** Encoded stdin header for the spawn wrapper (see protocol above). */
export function encodeSpawnHeader(fields: {
  argv: readonly string[];
  env: readonly string[];
  cwd: string;
  stdinIgnore: boolean;
  stdoutSpillMax?: number | undefined;
  stderrSpillMax?: number | undefined;
}): string {
  return [
    HEADER_MAGIC,
    b64(fields.argv.map((a) => `${a}\0`).join('')),
    b64(fields.env.map((e) => `${e}\0`).join('')),
    b64(fields.cwd),
    fields.stdinIgnore ? 'ignore' : '-',
    fields.stdoutSpillMax === undefined ? '-' : String(fields.stdoutSpillMax),
    fields.stderrSpillMax === undefined ? '-' : String(fields.stderrSpillMax),
    'END',
    '',
  ].join('\n');
}

/** Parse a status-file / END-frame payload into exit facts. */
export function parseStatusText(
  text: string,
): { exitCode: number | null; signal: NodeJS.Signals | null } | undefined {
  const trimmed = text.trim();
  const exit = /^exit:(\d{1,3})$/.exec(trimmed);
  if (exit) {
    const code = Number(exit[1]);
    if (code <= 255) return { exitCode: code, signal: null };
    return undefined;
  }
  const sig = /^signal:(SIG[A-Z0-9]+)$/.exec(trimmed);
  if (sig) return { exitCode: null, signal: sig[1] as NodeJS.Signals };
  return undefined;
}
