import { describe, expect, test } from "bun:test";
import { composeAbortSignals, Deadline } from "../src/deadline.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Deadline immediate expiry", () => {
  test("ms <= 0 is immediately expired with the internal reason", () => {
    for (const ms of [0, -1, -10_000]) {
      const deadline = new Deadline(ms);
      expect(deadline.expired()).toBe(true);
      expect(deadline.signal.aborted).toBe(true);
      expect(deadline.signal.reason).toBe("lcm-deadline");
      expect(deadline.userAborted()).toBe(false);
      expect(deadline.isUserAbort()).toBe(false);
      expect(deadline.remainingMs()).toBe(0);
    }
  });

  test("a past absolute deadline is immediately expired", () => {
    const deadline = Deadline.at(Date.now() - 1);
    expect(deadline.expired()).toBe(true);
    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.signal.reason).toBe("lcm-deadline");
  });

  test("expire() forces internal expiry and fires onExpire exactly once", () => {
    let fires = 0;
    const deadline = new Deadline(60_000, {
      onExpire: () => {
        fires += 1;
      },
    });
    expect(deadline.expired()).toBe(false);
    expect(deadline.signal.aborted).toBe(false);
    deadline.expire();
    expect(deadline.expired()).toBe(true);
    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.signal.reason).toBe("lcm-deadline");
    deadline.expire(); // idempotent: no second abort, no second callback
    expect(fires).toBe(1);
  });
});

describe("Deadline real wall-clock expiry", () => {
  test("expires after a short real delay and remainingMs decreases", async () => {
    const deadline = new Deadline(50);
    const initial = deadline.remainingMs();
    expect(initial).toBeGreaterThan(0);
    expect(initial).toBeLessThanOrEqual(50);
    expect(deadline.expired()).toBe(false);
    await sleep(25);
    expect(deadline.remainingMs()).toBeLessThan(initial);
    expect(deadline.expired()).toBe(false);
    await sleep(80);
    expect(deadline.expired()).toBe(true);
    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.signal.reason).toBe("lcm-deadline");
    expect(deadline.remainingMs()).toBe(0);
  });

  test("onExpire fires once at real internal expiry", async () => {
    let fires = 0;
    const deadline = new Deadline(30, {
      onExpire: () => {
        fires += 1;
      },
    });
    await sleep(80);
    expect(fires).toBe(1);
    expect(deadline.signal.reason).toBe("lcm-deadline");
  });
});

describe("Deadline user abort", () => {
  test("user abort wins and preserves its reason", () => {
    const user = new AbortController();
    const deadline = new Deadline(60_000, { signal: user.signal });
    expect(deadline.signal.aborted).toBe(false);
    expect(deadline.userAborted()).toBe(false);
    const reason = new Error("user cancelled");
    user.abort(reason);
    expect(deadline.userAborted()).toBe(true);
    expect(deadline.isUserAbort()).toBe(true);
    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.signal.reason).toBe(reason);
    expect(deadline.signal.reason).toBe(user.signal.reason);
    expect(deadline.signal.reason).not.toBe("lcm-deadline");
  });

  test("a reason-less user abort keeps the platform AbortError reason", () => {
    const user = new AbortController();
    const deadline = new Deadline(60_000, { signal: user.signal });
    user.abort();
    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.signal.reason).toBe(user.signal.reason);
    expect(deadline.signal.reason).toBeInstanceOf(DOMException);
  });

  test("an already-aborted user signal aborts the deadline immediately", () => {
    const user = new AbortController();
    user.abort("session ended");
    const deadline = new Deadline(60_000, { signal: user.signal });
    expect(deadline.userAborted()).toBe(true);
    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.signal.reason).toBe("session ended");
    expect(deadline.expired()).toBe(false); // internal expiry did not fire
  });

  test("user abort cancels the pending internal timer (real delay)", async () => {
    let fires = 0;
    const user = new AbortController();
    const deadline = new Deadline(30, {
      signal: user.signal,
      onExpire: () => {
        fires += 1;
      },
    });
    user.abort("stop");
    await sleep(80); // well past the 30ms internal deadline
    expect(fires).toBe(0);
    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.signal.reason).toBe("stop");
    expect(deadline.signal.reason).not.toBe("lcm-deadline");
  });
});

describe("Deadline.at absolute deadlines", () => {
  test("expires at the absolute epoch time", async () => {
    const deadlineAt = Date.now() + 40;
    const deadline = Deadline.at(deadlineAt);
    expect(deadline.deadlineAt).toBe(deadlineAt);
    expect(deadline.remainingMs()).toBeGreaterThan(0);
    expect(deadline.remainingMs()).toBeLessThanOrEqual(40);
    await sleep(80);
    expect(deadline.expired()).toBe(true);
    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.signal.reason).toBe("lcm-deadline");
  });

  test("Deadline.at respects a user signal", () => {
    const user = new AbortController();
    const deadline = Deadline.at(Date.now() + 60_000, { signal: user.signal });
    user.abort("stop now");
    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.signal.reason).toBe("stop now");
    expect(deadline.userAborted()).toBe(true);
  });
});

describe("composeAbortSignals", () => {
  test("joins a user signal and a deadline signal; user abort propagates its reason", () => {
    const user = new AbortController();
    const deadline = new Deadline(60_000);
    const composed = composeAbortSignals([user.signal, deadline.signal]);
    expect(composed.aborted).toBe(false);
    const reason = new Error("user stopped");
    user.abort(reason);
    expect(composed.aborted).toBe(true);
    expect(composed.reason).toBe(reason);
  });

  test("internal deadline expiry aborts the composed signal with lcm-deadline", async () => {
    const deadline = new Deadline(30);
    const composed = composeAbortSignals([
      new AbortController().signal,
      deadline.signal,
    ]);
    expect(composed.aborted).toBe(false);
    await sleep(80);
    expect(composed.aborted).toBe(true);
    expect(composed.reason).toBe("lcm-deadline");
  });

  test("a deadline's user abort flows through compose with the user reason", () => {
    const user = new AbortController();
    const deadline = new Deadline(60_000, { signal: user.signal });
    const composed = composeAbortSignals([deadline.signal]);
    const reason = new Error("session end");
    user.abort(reason);
    expect(composed.aborted).toBe(true);
    expect(composed.reason).toBe(user.signal.reason);
    expect(composed.reason).toBe(reason);
  });

  test("an already-aborted input aborts the composed signal immediately", () => {
    const user = new AbortController();
    user.abort("already done");
    const composed = composeAbortSignals([user.signal]);
    expect(composed.aborted).toBe(true);
    expect(composed.reason).toBe("already done");
  });

  test("an empty input produces a signal that never aborts", async () => {
    const composed = composeAbortSignals([]);
    await sleep(20);
    expect(composed.aborted).toBe(false);
  });
});
