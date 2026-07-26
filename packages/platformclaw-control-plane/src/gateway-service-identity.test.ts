import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createGatewayServiceHostDeps,
  loadGatewayServiceIdentity,
} from "./gateway-service-identity.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeIdentity(type: "ed25519" | "rsa"): string {
  const root = mkdtempSync(join(tmpdir(), "platformclaw-service-identity-"));
  roots.push(root);
  const filePath = join(root, "identity.pem");
  const { privateKey } =
    type === "ed25519"
      ? generateKeyPairSync("ed25519")
      : generateKeyPairSync("rsa", { modulusLength: 2048 });
  writeFileSync(filePath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  return filePath;
}

describe("Gateway service identity", () => {
  it("loads one stable Ed25519 identity and provides device-auth callbacks", () => {
    const identity = loadGatewayServiceIdentity(writeIdentity("ed25519"));
    const hostDeps = createGatewayServiceHostDeps(identity);
    const payload = "platformclaw-service-proof";
    const signature = hostDeps.signDevicePayload?.(identity.privateKeyPem, payload) ?? "";

    expect(identity.deviceId).toMatch(/^[a-f0-9]{64}$/u);
    expect(hostDeps.loadOrCreateDeviceIdentity?.()).toMatchObject({
      deviceId: identity.deviceId,
      publicKeyPem: identity.publicKeyPem,
    });
    expect(
      verify(
        null,
        Buffer.from(payload, "utf8"),
        identity.publicKeyPem,
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);

    hostDeps.storeDeviceAuthToken?.({
      deviceId: identity.deviceId,
      role: "operator",
      token: "device-token",
      scopes: ["operator.read", "operator.write"],
    });
    expect(
      hostDeps.loadDeviceAuthToken?.({ deviceId: identity.deviceId, role: "operator" }),
    ).toEqual({ token: "device-token", scopes: ["operator.read", "operator.write"] });
  });

  it("rejects a non-Ed25519 private key", () => {
    expect(() => loadGatewayServiceIdentity(writeIdentity("rsa"))).toThrow("must be an Ed25519");
  });
});
