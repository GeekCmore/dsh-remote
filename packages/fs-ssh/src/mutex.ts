/**
 * Per-key promise-chain mutex. Serializes the read-modify-write critical
 * sections of `writeText`/`editText` per `targetKey` inside this host process,
 * so two tool calls racing on one remote file cannot interleave their
 * observation and publication. Cross-process races are closed separately by
 * the guarded remote publish step.
 */

/** Runs tasks for the same key strictly one at a time, in call order. */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  /** Queue `task` behind any in-flight task for `key`. */
  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const tail = this.tails.get(key) ?? Promise.resolve();
    const result = tail.then(task, task);
    // The stored tail must never reject, or one failure would wedge the chain.
    const next = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, next);
    void next.then(() => {
      if (this.tails.get(key) === next) this.tails.delete(key);
    });
    return result;
  }
}
