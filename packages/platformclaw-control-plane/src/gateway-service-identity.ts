import { createHash, createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  DeviceAuthTokenRecord,
  DeviceIdentity,
  GatewayClientHostDeps,
} from "@openclaw/gateway-client";

const MAX_IDENTITY_FILE_BYTES = 16 * 1024;

export type GatewayServiceIdentity = DeviceIdentity & {
  publicKeyRawBase64Url: string;
};

function readPrivateKey(filePath: string): string {
  const resolvedPath = resolve(filePath);
  const stat = lstatSync(resolvedPath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("Gateway service identity must reference a regular file");
  }
  if (stat.size > MAX_IDENTITY_FILE_BYTES) {
    throw new Error(`Gateway service identity exceeds ${MAX_IDENTITY_FILE_BYTES} bytes`);
  }
  const value = readFileSync(resolvedPath, "utf8").trim();
  if (!value) {
    throw new Error("Gateway service identity is empty");
  }
  return value;
}

function requireEd25519PrivateKey(privateKeyPem: string): void {
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(privateKeyPem);
  } catch {
    throw new Error("Gateway service identity is not a valid private key");
  }
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Gateway service identity must be an Ed25519 private key");
  }
}

function rawPublicKey(publicKey: KeyObject): string {
  const jwk = publicKey.export({ format: "jwk" });
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") {
    throw new Error("Gateway service identity has an invalid Ed25519 public key");
  }
  return jwk.x;
}

export function loadGatewayServiceIdentity(filePath: string): GatewayServiceIdentity {
  const privateKeyPem = readPrivateKey(filePath);
  requireEd25519PrivateKey(privateKeyPem);
  const publicKey = createPublicKey(privateKeyPem);
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
  const publicKeyRawBase64Url = rawPublicKey(publicKey);
  const deviceId = createHash("sha256")
    .update(Buffer.from(publicKeyRawBase64Url, "base64url"))
    .digest("hex");
  return { deviceId, privateKeyPem, publicKeyPem, publicKeyRawBase64Url };
}

/** Keeps the service token process-local; the durable trust anchor is the mounted identity. */
export function createGatewayServiceHostDeps(
  identity: GatewayServiceIdentity,
): GatewayClientHostDeps {
  let token: DeviceAuthTokenRecord | null = null;
  return {
    loadOrCreateDeviceIdentity: () => identity,
    signDevicePayload: (privateKeyPem, payload) =>
      sign(null, Buffer.from(payload, "utf8"), privateKeyPem).toString("base64url"),
    publicKeyRawBase64UrlFromPem: (publicKeyPem) => rawPublicKey(createPublicKey(publicKeyPem)),
    loadDeviceAuthToken: () => token,
    storeDeviceAuthToken: (entry) => {
      token = { token: entry.token, scopes: [...entry.scopes] };
    },
    clearDeviceAuthToken: () => {
      token = null;
    },
  };
}
