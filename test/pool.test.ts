import { describe, expect, test } from "bun:test";
import { runBoundedPool } from "../src/pool.ts";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("waitFor: condition never became true");
    }
    await sleep(5);
  }
}

describe("bounded worker pool", () => {
  test("never exceeds the configured concurrency", async () => {
    const items = Array.from({ length: 8 }, (_, i) => i);
    const gates = items.map(() => deferred<void>());
    const started: number[] = [];
    let active = 0;
    let peak = 0;
    const worker = async (item: number, index: number): Promise<string> => {
      started.push(index);
      active++;
      peak = Math.max(peak, active);
      await gates[index]?.promise;
      active--;
      return `v${item}`;
    };

    const pool = runBoundedPool(items, 3, worker);
    await waitFor(() => started.length === 3);
    await sleep(30);
    expect(started.length).toBe(3);
    expect(peak).toBe(3);

    gates[0]?.resolve();
    await waitFor(() => started.length === 4);
    await sleep(30);
    expect(started.length).toBe(4);
    expect(peak).toBe(3);

    for (let i = 1; i < gates.length; i++) {
      gates[i]?.resolve();
    }
    const results = await pool;

    expect(peak).toBeLessThanOrEqual(3);
    expect(started).toEqual(items);
    expect(results.map((r) => r.status)).toEqual(items.map(() => "ok"));
    expect(results.map((r) => (r.status === "ok" ? r.value : null))).toEqual([
      "v0",
      "v1",
      "v2",
      "v3",
      "v4",
      "v5",
      "v6",
      "v7",
    ]);
  });

  test("overlaps at least two calls when concurrency is greater than one", async () => {
    const gate = deferred<void>();
    let active = 0;
    let sawOverlap = false;
    const worker = async (item: number): Promise<number> => {
      active++;
      if (active >= 2) {
        sawOverlap = true;
      }
      await gate.promise;
      active--;
      return item * 10;
    };

    const pool = runBoundedPool([1, 2, 3], 2, worker);
    await waitFor(() => active === 2);
    expect(sawOverlap).toBe(true);
    gate.resolve();
    const results = await pool;

    expect(sawOverlap).toBe(true);
    expect(results.map((r) => (r.status === "ok" ? r.value : null))).toEqual([
      10, 20, 30,
    ]);
  });

  test("reversed completion order still yields input-ordered results", async () => {
    const items = ["a", "b", "c", "d"];
    const gates = items.map(() => deferred<string>());
    const started: number[] = [];
    const finished: number[] = [];
    const worker = (_item: string, index: number): Promise<string> => {
      started.push(index);
      return gates[index]?.promise.then((value) => {
        finished.push(index);
        return value;
      });
    };

    const pool = runBoundedPool(items, 4, worker);
    await waitFor(() => started.length === 4);
    for (let i = 3; i >= 0; i--) {
      gates[i]?.resolve(`r${i}`);
    }
    const results = await pool;

    expect(finished).toEqual([3, 2, 1, 0]);
    expect(results).toEqual([
      { index: 0, status: "ok", value: "r0" },
      { index: 1, status: "ok", value: "r1" },
      { index: 2, status: "ok", value: "r2" },
      { index: 3, status: "ok", value: "r3" },
    ]);
  });

  test("a synchronous worker throw fails only its own index and does not strand the pool", async () => {
    const items = Array.from({ length: 6 }, (_, i) => i);
    const gates = items.map(() => deferred<void>());
    const started: number[] = [];
    const worker = (item: number, index: number): Promise<string> => {
      started.push(index);
      if (index === 1) {
        throw new Error("sync boom");
      }
      return gates[index]?.promise.then(() => `done${item}`);
    };

    const pool = runBoundedPool(items, 2, worker);
    await waitFor(() => started.length === 3);
    await sleep(30);
    expect(started).toEqual([0, 1, 2]);
    for (const gate of gates) {
      gate.resolve();
    }
    const results = await pool;

    expect(started).toEqual(items);
    expect(results[1]?.status).toBe("failed");
    if (results[1]?.status === "failed") {
      expect(results[1].error).toBeInstanceOf(Error);
      expect((results[1].error as Error).message).toBe("sync boom");
    }
    expect(results.map((r) => (r.status === "ok" ? r.value : null))).toEqual([
      "done0",
      null,
      "done2",
      "done3",
      "done4",
      "done5",
    ]);
  });

  test("aborting the signal skips unpicked items while in-flight workers settle", async () => {
    const items = Array.from({ length: 6 }, (_, i) => i);
    const controller = new AbortController();
    const gates = items.map(() => deferred<string>());
    const started: number[] = [];
    const settled: number[] = [];
    const worker = async (item: number, index: number): Promise<string> => {
      started.push(index);
      try {
        await gates[index]?.promise;
        return `ok${item}`;
      } finally {
        settled.push(index);
      }
    };

    const pool = runBoundedPool(items, 2, worker, {
      signal: controller.signal,
    });
    await waitFor(() => started.length === 2);

    controller.abort();
    await sleep(30);
    expect(started).toEqual([0, 1]);

    gates[0]?.resolve("ignored");
    gates[1]?.resolve("ignored");
    const results = await pool;

    expect(started).toEqual([0, 1]);
    expect(settled).toEqual([0, 1]);
    expect(results[0]).toMatchObject({ index: 0, status: "ok", value: "ok0" });
    expect(results[1]).toMatchObject({ index: 1, status: "ok", value: "ok1" });
    expect(results.slice(2)).toEqual([
      { index: 2, status: "skipped" },
      { index: 3, status: "skipped" },
      { index: 4, status: "skipped" },
      { index: 5, status: "skipped" },
    ]);
  });

  test("a pre-aborted signal skips every item without calling the worker", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const results = await runBoundedPool(
      [1, 2, 3],
      2,
      async (item) => {
        calls++;
        return item;
      },
      { signal: controller.signal },
    );
    expect(calls).toBe(0);
    expect(results).toEqual([
      { index: 0, status: "skipped" },
      { index: 1, status: "skipped" },
      { index: 2, status: "skipped" },
    ]);
  });

  test("returns [] for empty items without calling the worker", async () => {
    let calls = 0;
    const results = await runBoundedPool<number, string>(
      [],
      4,
      async (item) => {
        calls++;
        return String(item);
      },
    );
    expect(results).toEqual([]);
    expect(calls).toBe(0);
  });

  test("clamps non-positive concurrency to 1", async () => {
    for (const badConcurrency of [0, -1]) {
      const gate = deferred<void>();
      const started: number[] = [];
      let active = 0;
      let peak = 0;
      const worker = async (item: number, index: number): Promise<number> => {
        started.push(index);
        active++;
        peak = Math.max(peak, active);
        await gate.promise;
        active--;
        return item;
      };

      const pool = runBoundedPool([10, 20, 30], badConcurrency, worker);
      await waitFor(() => started.length === 1);
      await sleep(30);
      expect(started).toEqual([0]);
      expect(peak).toBe(1);

      gate.resolve();
      const results = await pool;

      expect(peak).toBe(1);
      expect(started).toEqual([0, 1, 2]);
      expect(results).toEqual([
        { index: 0, status: "ok", value: 10 },
        { index: 1, status: "ok", value: 20 },
        { index: 2, status: "ok", value: 30 },
      ]);
    }
  });
});
