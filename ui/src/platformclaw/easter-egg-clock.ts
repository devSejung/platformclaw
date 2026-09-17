type Timer = {
  callback: () => void;
  handle: ReturnType<typeof setTimeout> | null;
  remainingMs: number;
  startedAt: number;
};

/** Keeps every game deadline on the same clock while the shop or tab is paused. */
export class PausableGameClock<Key extends string> {
  private readonly timers = new Map<Key, Timer>();

  constructor(private readonly now: () => number) {}

  schedule(key: Key, delayMs: number, callback: () => void, paused: boolean): void {
    this.clear(key);
    const timer: Timer = {
      callback,
      handle: null,
      remainingMs: delayMs,
      startedAt: this.now(),
    };
    this.timers.set(key, timer);
    if (!paused) {
      this.arm(key, timer);
    }
  }

  clear(key: Key): void {
    const timer = this.timers.get(key);
    if (timer?.handle !== null && timer?.handle !== undefined) {
      clearTimeout(timer.handle);
    }
    this.timers.delete(key);
  }

  clearAll(): void {
    for (const key of this.timers.keys()) {
      this.clear(key);
    }
  }

  pause(): void {
    const now = this.now();
    for (const timer of this.timers.values()) {
      if (timer.handle === null) {
        continue;
      }
      clearTimeout(timer.handle);
      timer.handle = null;
      timer.remainingMs = Math.max(0, timer.remainingMs - (now - timer.startedAt));
    }
  }

  resume(): void {
    for (const [key, timer] of this.timers) {
      if (timer.handle === null) {
        this.arm(key, timer);
      }
    }
  }

  private arm(key: Key, timer: Timer): void {
    timer.startedAt = this.now();
    timer.handle = setTimeout(() => {
      if (this.timers.get(key) !== timer) {
        return;
      }
      this.timers.delete(key);
      timer.callback();
    }, timer.remainingMs);
  }
}
