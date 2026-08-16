/**
 * In-memory bidirectional byte-stream plumbing for tests. A BytePipe is an
 * AsyncIterable that yields whatever another party pushes into it; pairing
 * two pipes gives both ends of a connection without touching the network,
 * SSH, or the filesystem.
 */

/** One direction of an in-memory byte stream. */
export class BytePipe implements AsyncIterable<Uint8Array> {
  #queue: Uint8Array[] = [];
  #waiter: ((r: IteratorResult<Uint8Array>) => void) | null = null;
  #ended = false;

  /** Feed bytes into the stream (i.e. what the remote peer sent). */
  push(chunk: Uint8Array): void {
    if (this.#ended) throw new Error('pipe already ended');
    if (this.#waiter) {
      const waiter = this.#waiter;
      this.#waiter = null;
      waiter({ value: chunk, done: false });
    } else {
      this.#queue.push(chunk);
    }
  }

  /** Signal end-of-stream (remote closed the connection). */
  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    if (this.#waiter) {
      const waiter = this.#waiter;
      this.#waiter = null;
      waiter({ value: undefined, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
    for (;;) {
      const head = this.#queue.shift();
      if (head !== undefined) {
        yield head;
        continue;
      }
      if (this.#ended) return;
      const next = await new Promise<IteratorResult<Uint8Array>>((resolve) => {
        this.#waiter = resolve;
      });
      if (next.done) return;
      yield next.value;
    }
  }
}

/** Both directions of an in-memory connection: `aIn` is what A reads, `bIn` what B reads. */
export function pipePair(): { aIn: BytePipe; bIn: BytePipe } {
  return { aIn: new BytePipe(), bIn: new BytePipe() };
}

/** Let queued microtasks/macrotasks run so async pumps can deliver. */
export function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Decode captured output lines back into parsed messages. */
export function decodeLines(lines: Uint8Array[]): unknown[] {
  const text = new TextDecoder().decode(
    lines.reduce((acc, l) => {
      const merged = new Uint8Array(acc.length + l.length);
      merged.set(acc);
      merged.set(l, acc.length);
      return merged;
    }, new Uint8Array(0)),
  );
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}
