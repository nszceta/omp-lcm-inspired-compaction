export type PoolOutcome<T> =
  | { index: number; status: "ok"; value: T }
  | { index: number; status: "failed"; error: unknown }
  | { index: number; status: "skipped" }; // never started (signal aborted before its turn)

export interface PoolOptions {
  signal?: AbortSignal; // abort => stop dequeuing NEW items; in-flight workers are awaited
}

export async function runBoundedPool<I, O>(
  items: readonly I[],
  concurrency: number,
  worker: (item: I, index: number) => Promise<O>,
  options?: PoolOptions,
): Promise<PoolOutcome<O>[]> {
  const results: PoolOutcome<O>[] = new Array<PoolOutcome<O>>(items.length);
  if (items.length === 0) {
    return results;
  }

  const floored = Math.floor(concurrency);
  const fallback = Number.isFinite(floored) ? floored : 1;
  const effective = Math.min(Math.max(fallback, 1), items.length);
  const signal = options?.signal;
  let next = 0;

  const run = async (): Promise<void> => {
    while (true) {
      if (signal?.aborted) {
        return;
      }
      const index = next++;
      if (index >= items.length) {
        return;
      }
      let outcome: PoolOutcome<O>;
      try {
        const value = await worker(items[index], index);
        outcome = { index, status: "ok", value };
      } catch (error) {
        outcome = { index, status: "failed", error };
      }
      results[index] = outcome;
    }
  };

  const runners: Promise<void>[] = [];
  for (let i = 0; i < effective; i++) {
    runners.push(run());
  }
  await Promise.all(runners);

  for (let i = next; i < items.length; i++) {
    results[i] = { index: i, status: "skipped" };
  }
  return results;
}
