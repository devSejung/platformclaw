import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ExecCredentialCipher } from "./exec-credential-crypto.js";

describe("ExecCredentialCipher", () => {
  it("round-trips a bounded value without storing plaintext", () => {
    const cipher = ExecCredentialCipher.fromBase64(randomBytes(32).toString("base64"));
    const envelope = cipher.encrypt("user-1", "API_TOKEN", "secret-value");

    expect(Buffer.from(envelope.ciphertext).toString("utf8")).not.toContain("secret-value");
    expect(cipher.decrypt("user-1", "API_TOKEN", envelope)).toBe("secret-value");
  });

  it("binds ciphertext to its user and environment name", () => {
    const cipher = ExecCredentialCipher.fromBase64(randomBytes(32).toString("base64"));
    const envelope = cipher.encrypt("user-1", "API_TOKEN", "secret-value");

    expect(() => cipher.decrypt("user-2", "API_TOKEN", envelope)).toThrow(
      "exec credential decryption failed",
    );
    expect(() => cipher.decrypt("user-1", "OTHER_TOKEN", envelope)).toThrow(
      "exec credential decryption failed",
    );
  });

  it("rejects values unsafe for the stdin framing contract", () => {
    const cipher = ExecCredentialCipher.fromBase64(randomBytes(32).toString("base64"));
    expect(() => cipher.encrypt("user-1", "API_TOKEN", "line-one\nline-two")).toThrow(
      "exec credential value is invalid",
    );
  });
});
