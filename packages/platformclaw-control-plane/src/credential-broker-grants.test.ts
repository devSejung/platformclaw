import { describe, expect, it, vi } from "vitest";
import { OneShotCredentialGrantStore } from "./credential-broker-grants.js";

describe("OneShotCredentialGrantStore", () => {
  it("redeems a grant exactly once", async () => {
    const resolve = vi.fn(async () => ({ password: Buffer.from("secret"), revision: 3 }));
    const grants = new OneShotCredentialGrantStore({ tokenFactory: () => "a".repeat(43) });
    const grant = grants.issue(resolve);

    const credential = await grants.redeem(grant.token);
    expect(credential.password.toString("utf8")).toBe("secret");
    expect(credential.revision).toBe(3);
    credential.password.fill(0);
    await expect(grants.redeem(grant.token)).rejects.toThrow("invalid or already used");
    expect(resolve).toHaveBeenCalledOnce();
  });

  it("disposes transient grant material after redemption or revocation", async () => {
    const grants = new OneShotCredentialGrantStore({
      tokenFactory: () => "transient_grant_token_1234567890123456",
    });
    const dispose = vi.fn();
    const grant = grants.issue(
      async () => ({ password: Buffer.from("secret"), revision: 1 }),
      dispose,
    );

    await grants.redeem(grant.token);
    expect(dispose).toHaveBeenCalledOnce();

    const revoked = new OneShotCredentialGrantStore({
      tokenFactory: () => "revoked_grant_token_12345678901234567",
    });
    const revokeDispose = vi.fn();
    const revokeGrant = revoked.issue(
      async () => ({ password: Buffer.from("secret"), revision: 1 }),
      revokeDispose,
    );
    revoked.revoke(revokeGrant.token);
    expect(revokeDispose).toHaveBeenCalledOnce();
  });

  it("expires grants and consumes them when resolution fails", async () => {
    let now = 1_000;
    const grants = new OneShotCredentialGrantStore({
      now: () => now,
      ttlMs: 1_000,
      tokenFactory: () => "b".repeat(43),
    });
    const disposeExpired = vi.fn();
    const expired = grants.issue(
      async () => ({ password: Buffer.from("old"), revision: 1 }),
      disposeExpired,
    );
    now = expired.expiresAt;
    await expect(grants.redeem(expired.token)).rejects.toThrow("invalid or expired");
    expect(disposeExpired).toHaveBeenCalledOnce();

    const failing = new OneShotCredentialGrantStore({ tokenFactory: () => "c".repeat(43) });
    const grant = failing.issue(async () => {
      throw new Error("vault unavailable");
    });
    await expect(failing.redeem(grant.token)).rejects.toThrow("vault unavailable");
    await expect(failing.redeem(grant.token)).rejects.toThrow("invalid or already used");
  });

  it("disposes abandoned transient material when its TTL elapses", () => {
    vi.useFakeTimers();
    try {
      const dispose = vi.fn();
      const grants = new OneShotCredentialGrantStore({
        ttlMs: 1_000,
        tokenFactory: () => "expired_grant_token_12345678901234567",
      });
      grants.issue(async () => ({ password: Buffer.from("old"), revision: 1 }), dispose);

      vi.advanceTimersByTime(1_000);

      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds pending grants and rejects invalid resolver output", async () => {
    let sequence = 0;
    const grants = new OneShotCredentialGrantStore({
      maxPendingGrants: 1,
      tokenFactory: () => `${sequence++}`.padEnd(43, "d"),
    });
    grants.issue(async () => ({ password: Buffer.from("one"), revision: 1 }));
    expect(() => grants.issue(async () => ({ password: Buffer.from("two"), revision: 1 }))).toThrow(
      "capacity reached",
    );

    const invalid = new OneShotCredentialGrantStore({ tokenFactory: () => "e".repeat(43) });
    const grant = invalid.issue(async () => ({ password: Buffer.alloc(0), revision: 1 }));
    await expect(invalid.redeem(grant.token)).rejects.toThrow("invalid bytes");
  });
});
