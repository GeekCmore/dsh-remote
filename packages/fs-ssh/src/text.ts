/**
 * Text helpers shared by the read and mutation paths: LF normalization (the
 * in-memory diff basis), CRLF round-tripping, binary rejection via NUL probe,
 * and literal match counting for `editText`.
 */

/** Normalize CRLF line endings to LF — the provider's in-memory text basis. */
export function normalizeLf(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/** Whether the raw storage text uses CRLF line endings anywhere. */
export function hasCrlf(text: string): boolean {
  return text.includes('\r\n');
}

/** Convert an LF-normalized in-memory text back to CRLF storage form. */
export function toCrlf(text: string): string {
  return text.replace(/\n/g, '\r\n');
}

/** How many leading bytes are inspected for NUL before content is trusted as text. */
export const BINARY_PROBE_BYTES = 8192;

/**
 * Incremental binary detector: feed chunks in order; once
 * {@link BINARY_PROBE_BYTES} have been inspected the verdict is final and
 * later chunks pass through unchecked.
 */
export class BinaryProbe {
  private inspected = 0;
  private binary = false;

  /** Feed one chunk; returns the current "is binary" verdict. */
  push(chunk: Uint8Array): boolean {
    if (this.binary) return true;
    if (this.inspected >= BINARY_PROBE_BYTES) return false;
    const n = Math.min(chunk.length, BINARY_PROBE_BYTES - this.inspected);
    for (let i = 0; i < n; i++) {
      if (chunk[i] === 0) {
        this.binary = true;
        return true;
      }
    }
    this.inspected += n;
    return false;
  }
}

/** Count non-overlapping literal occurrences of `needle` in `haystack`. */
export function countLiteral(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return count;
    count++;
    from = at + needle.length;
  }
}

/** Replace the first (or every) literal occurrence of `needle`. */
export function replaceLiteral(haystack: string, needle: string, replacement: string, all: boolean): string {
  if (all) return haystack.split(needle).join(replacement);
  const at = haystack.indexOf(needle);
  if (at < 0) return haystack;
  return haystack.slice(0, at) + replacement + haystack.slice(at + needle.length);
}

/** Concatenate byte chunks into one buffer. */
export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
