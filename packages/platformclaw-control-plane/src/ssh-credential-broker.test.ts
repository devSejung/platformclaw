import { describe, expect, it } from "vitest";
import { createCredentialBrokerRuntimeAddress } from "./ssh-credential-broker.js";

describe("createCredentialBrokerRuntimeAddress", () => {
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
