import type { BrowserLoginRateLimiter } from "./browser-auth-http.js";

const DEFAULT_FAILURE_LIMIT = 5;
const DEFAULT_WINDOW_MS = 10 * 60 * 1_000;
const DEFAULT_BLOCK_MS = 15 * 60 * 1_000;
const DEFAULT_MAX_KEYS = 10_000;

type LoginRateEntry = {
  failures: number;
  windowStartedAt: number;
  blockedUntil: number;
  lastSeenAt: number;
};

export type MemoryBrowserLoginRateLimiterOptions = {
  failureLimit?: number;
  windowMs?: number;
  blockMs?: number;
  maxKeys?: number;
  now?: () => number;
};

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

/** Bounded process-local protection for employee password login attempts. */
export class MemoryBrowserLoginRateLimiter implements BrowserLoginRateLimiter {
  private readonly entries = new Map<string, LoginRateEntry>();
  private readonly failureLimit: number;
  private readonly windowMs: number;
  private readonly blockMs: number;
  private readonly maxKeys: number;
  private readonly now: () => number;

  constructor(options: MemoryBrowserLoginRateLimiterOptions = {}) {
    this.failureLimit = positiveInteger(
      options.failureLimit ?? DEFAULT_FAILURE_LIMIT,
      "login failure limit",
    );
    this.windowMs = positiveInteger(options.windowMs ?? DEFAULT_WINDOW_MS, "login window");
    this.blockMs = positiveInteger(options.blockMs ?? DEFAULT_BLOCK_MS, "login block duration");
    this.maxKeys = positiveInteger(options.maxKeys ?? DEFAULT_MAX_KEYS, "login rate-limit key cap");
    this.now = options.now ?? Date.now;
  }

  check(clientIp: string | undefined, scope: string): { allowed: boolean; retryAfterMs: number } {
    const now = this.now();
    const entry = this.entries.get(this.key(clientIp, scope));
    if (!entry) {
      return { allowed: true, retryAfterMs: 0 };
    }
    entry.lastSeenAt = now;
    if (entry.blockedUntil > now) {
      return { allowed: false, retryAfterMs: entry.blockedUntil - now };
    }
    if (now - entry.windowStartedAt >= this.windowMs) {
      this.entries.delete(this.key(clientIp, scope));
    }
    return { allowed: true, retryAfterMs: 0 };
  }

  recordFailure(clientIp: string | undefined, scope: string): void {
    const now = this.now();
    const key = this.key(clientIp, scope);
    const current = this.entries.get(key);
    const entry =
      !current || now - current.windowStartedAt >= this.windowMs
        ? { failures: 0, windowStartedAt: now, blockedUntil: 0, lastSeenAt: now }
        : current;
    entry.failures += 1;
    entry.lastSeenAt = now;
    if (entry.failures >= this.failureLimit) {
      entry.blockedUntil = now + this.blockMs;
    }
    this.entries.set(key, entry);
    this.evictOldestKeys();
  }

  private key(clientIp: string | undefined, scope: string): string {
    return `${scope}\u0000${clientIp?.trim() || "unknown"}`;
  }

  private evictOldestKeys(): void {
    while (this.entries.size > this.maxKeys) {
      let oldestKey: string | undefined;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [key, entry] of this.entries) {
        if (entry.lastSeenAt < oldestAt) {
          oldestAt = entry.lastSeenAt;
          oldestKey = key;
        }
      }
      if (!oldestKey) {
        return;
      }
      this.entries.delete(oldestKey);
    }
  }
}
