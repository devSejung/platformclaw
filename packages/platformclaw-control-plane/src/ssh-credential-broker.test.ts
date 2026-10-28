import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { redeemLocalCredentialGrant } from "./credential-broker-local.js";
import {
  createCredentialBrokerRuntimeAddress,
  SshCredentialBroker,
} from "./ssh-credential-broker.js";

describe("createCredentialBrokerRuntimeAddress", () => {
  it("revalidates scoped transient authority when bytes are redeemed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pc-scope-"));
    const address =
      process.platform === "win32"
        ? String.raw`\\.\pipe\pc-scope-${randomUUID()}`
        : join(directory, "broker.sock");
    const broker = new SshCredentialBroker(address, { resolveForBroker: vi.fn() });
    try {
      await broker.listen();
      const validate = vi.fn(async () => {
        throw new Error("destination revoked");
      });
      const secret = Buffer.from("synthetic-scoped-password");
      const grant = broker.issueTransient(secret, validate);
      secret.fill(0);
      await expect(
        redeemLocalCredentialGrant({ address: broker.address, token: grant.token }),
      ).rejects.toThrow("rejected the grant");
      expect(validate).toHaveBeenCalledOnce();
      const valid = broker.issueTransient(Buffer.from("synthetic-allowed"), async () => undefined);
      const redeemed = await redeemLocalCredentialGrant({
        address: broker.address,
        token: valid.token,
      });
      expect(redeemed.password.toString("utf8")).toBe("synthetic-allowed");
      redeemed.password.fill(0);
    } finally {
      await broker.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("creates a new address for each Control process lifetime", () => {
    const baseAddress =
      process.platform === "win32"
        ? String.raw`\\.\pipe\platformclaw-credential-broker`
        : "/run/platformclaw-credential-broker/credential.sock";

    const first = createCredentialBrokerRuntimeAddress(baseAddress, "1".repeat(8));
    const second = createCredentialBrokerRuntimeAddress(baseAddress, "2".repeat(8));

    expect(first).not.toBe(second);
    expect(first).toContain("1".repeat(8));
    expect(second).toContain("2".repeat(8));
    if (process.platform !== "win32") {
      expect(first).toMatch(/[A-Za-z0-9_-]{8}\.sock$/u);
    }
  });

  it("rejects caller-supplied unsafe nonce text", () => {
    expect(() =>
      createCredentialBrokerRuntimeAddress("/run/platformclaw/credential.sock", "../escape"),
    ).toThrow("runtime nonce is invalid");
  });

  it.runIf(process.platform !== "win32")("rejects an overlong Unix runtime directory", () => {
    const longBaseAddress = `/${"nested/".repeat(15)}credential.sock`;

    expect(() => createCredentialBrokerRuntimeAddress(longBaseAddress, "a".repeat(8))).toThrow(
      "runtime directory path is too long",
    );
  });
});
