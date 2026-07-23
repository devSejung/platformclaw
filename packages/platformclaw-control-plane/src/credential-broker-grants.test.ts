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

  it("expires grants and consumes them when resolution fails", async () => {
    let now = 1_000;
    const grants = new OneShotCredentialGrantStore({
      now: () => now,
      ttlMs: 1_000,
      tokenFactory: () => "b".repeat(43),
    });
    const expired = grants.issue(async () => ({ password: Buffer.from("old"), revision: 1 }));
    now = expired.expiresAt;
    await expect(grants.redeem(expired.token)).rejects.toThrow("invalid or expired");

    const failing = new OneShotCredentialGrantStore({ tokenFactory: () => "c".repeat(43) });
    const grant = failing.issue(async () => {
      throw new Error("vault unavailable");
    });
    await expect(failing.redeem(grant.token)).rejects.toThrow("vault unavailable");
    await expect(failing.redeem(grant.token)).rejects.toThrow("invalid or already used");
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
