import { describe, expect, it } from "vitest";
import { MemoryBrowserLoginRateLimiter } from "./browser-login-rate-limiter.js";

describe("MemoryBrowserLoginRateLimiter", () => {
  it("blocks repeated failures and resets after the window", () => {
    let now = 1_000;
    const limiter = new MemoryBrowserLoginRateLimiter({
      failureLimit: 2,
      windowMs: 100,
      blockMs: 50,
      now: () => now,
    });

    limiter.recordFailure("192.0.2.1", "login");
    expect(limiter.check("192.0.2.1", "login")).toEqual({ allowed: true, retryAfterMs: 0 });
    limiter.recordFailure("192.0.2.1", "login");
    expect(limiter.check("192.0.2.1", "login")).toEqual({
      allowed: false,
      retryAfterMs: 50,
    });

    now += 100;
    expect(limiter.check("192.0.2.1", "login")).toEqual({ allowed: true, retryAfterMs: 0 });
  });

  it("bounds independent client keys", () => {
    let now = 1;
    const limiter = new MemoryBrowserLoginRateLimiter({ maxKeys: 2, now: () => now++ });
    limiter.recordFailure("192.0.2.1", "login");
    limiter.recordFailure("192.0.2.2", "login");
    limiter.recordFailure("192.0.2.3", "login");

    for (let attempt = 0; attempt < 4; attempt += 1) {
      limiter.recordFailure("192.0.2.1", "login");
    }
    expect(limiter.check("192.0.2.1", "login").allowed).toBe(true);
  });
});
