export interface DeadlineOptions {
  signal?: AbortSignal; // user/session signal; its abort always wins and preserves its reason
  onExpire?: () => void;
}

const INTERNAL_REASON = "lcm-deadline";

/**
 * A wall-clock deadline that exposes an abort signal distinguishing internal
 * expiry (reason "lcm-deadline") from user cancellation (the user signal's
 * reason). The timer is unref'd so a pending deadline never keeps the process
 * alive.
 */
export class Deadline {
  /** Epoch ms; ms <= 0 or already-past -> immediately expired. */
  get deadlineAt(): number {
    return this._deadlineAt;
  }

  /** Aborts with reason "lcm-deadline" on internal expiry; aborts with user reason on user abort. */
  readonly signal: AbortSignal;

  private readonly controller: AbortController;
  private readonly options: DeadlineOptions;
  private readonly onUserAbort = (): void => this.propagateUserAbort();
  private _deadlineAt: number;
  private timer: Timer | undefined;
  private expiredFlag = false;

  constructor(ms: number, options: DeadlineOptions = {}) {
    this.options = options;
    this.controller = new AbortController();
    this.signal = this.controller.signal;
    this._deadlineAt = Date.now() + ms;

    const user = options.signal;
    if (user) {
      user.addEventListener("abort", this.onUserAbort, { once: true });
      if (user.aborted) {
        this.propagateUserAbort();
      }
    }
    if (ms <= 0) {
      this.expire();
    } else {
      this.startTimer(ms);
    }
  }

  /** Absolute epoch-ms variant; a past deadline is immediately expired. */
  static at(deadlineAt: number, options: DeadlineOptions = {}): Deadline {
    const deadline = new Deadline(deadlineAt - Date.now(), options);
    // Pin the exact absolute value instead of the constructor's recomputed one.
    deadline._deadlineAt = deadlineAt;
    return deadline;
  }

  /** Remaining wall-clock time, clamped at zero. */
  remainingMs(): number {
    return Math.max(0, this._deadlineAt - Date.now());
  }

  /** True once the wall clock passed the deadline or internal expiry fired. */
  expired(): boolean {
    return this.expiredFlag || Date.now() >= this._deadlineAt;
  }

  /** True when the user/session signal is aborted. */
  userAborted(): boolean {
    return this.options.signal?.aborted === true;
  }

  /** Alias of {@link userAborted}. */
  isUserAbort(): boolean {
    return this.userAborted();
  }

  /** Force internal expiry now (tests/manual). */
  expire(): void {
    if (this.expiredFlag) {
      return;
    }
    // A user abort always wins: once the user has cancelled, an internal
    // expiry must not fire onExpire or overwrite the user's reason.
    if (this.userAborted()) {
      return;
    }
    this.expiredFlag = true;
    this.clearTimer();
    this.options.signal?.removeEventListener("abort", this.onUserAbort);
    this.controller.abort(INTERNAL_REASON);
    this.options.onExpire?.();
  }

  private startTimer(ms: number): void {
    const timer = setTimeout(() => this.expire(), ms);
    // Keep the event loop free while a deadline is pending.
    timer.unref();
    this.timer = timer;
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private propagateUserAbort(): void {
    this.clearTimer();
    if (!this.controller.signal.aborted) {
      this.controller.abort(
        this.options.signal?.reason ??
          new DOMException("The operation was aborted", "AbortError"),
      );
    }
  }
}

/**
 * Settle with `promise`'s result, or reject as soon as `signal` aborts with
 * an AbortError carrying the signal's reason. The underlying promise is not
 * cancelled; it may keep running after the race settles.
 */
export function raceWithSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      const reason = signal.reason;
      reject(
        reason instanceof Error
          ? reason
          : Object.assign(new Error("The operation was aborted"), {
              name: "AbortError",
              reason,
            }),
      );
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    // Always consume the underlying promise so a late rejection is handled.
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Join signals into one that aborts with the reason of the first (in array
 * order) input that aborts. An already-aborted input aborts the result
 * immediately.
 */
export function composeAbortSignals(
  signals: readonly AbortSignal[],
): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), {
      once: true,
    });
  }
  return controller.signal;
}
