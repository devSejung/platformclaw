import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createSecretKey,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { TextDecoder } from "node:util";
import { ControlPlaneStateError } from "./contracts.js";
import type { McpCredentialEnvelope, McpCredentialPayload } from "./mcp-credential-contracts.js";

const CIPHER = "aes-256-gcm";
const FORMAT_VERSION = 1 as const;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function decodeCanonicalBase64(value: string): Buffer {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(normalized) || normalized.length % 4 !== 0) {
    throw new ControlPlaneStateError("MCP credential master key must be canonical Base64");
  }
  const decoded = Buffer.from(normalized, "base64");
  if (decoded.toString("base64") !== normalized) {
    decoded.fill(0);
    throw new ControlPlaneStateError("MCP credential master key must be canonical Base64");
  }
  return decoded;
}

function additionalAuthenticatedData(userId: string, serverName: string, keyId: string): Buffer {
  return Buffer.from(
    `platformclaw:mcp-credential:v${FORMAT_VERSION}\0${userId}\0${serverName}\0${keyId}`,
    "utf8",
  );
}

export class McpCredentialCipher {
  readonly keyId: string;
  private readonly key: KeyObject;

  private constructor(key: KeyObject, keyId: string) {
    this.key = key;
    this.keyId = keyId;
  }

  static fromBase64(masterKeyBase64: string): McpCredentialCipher {
    const keyBytes = decodeCanonicalBase64(masterKeyBase64);
    try {
      if (keyBytes.length !== 32) {
        throw new ControlPlaneStateError("MCP credential master key must decode to 32 bytes");
      }
      const keyId = `sha256:${createHash("sha256").update(keyBytes).digest("base64url")}`;
      return new McpCredentialCipher(createSecretKey(keyBytes), keyId);
    } finally {
      keyBytes.fill(0);
    }
  }

  encrypt(
    userId: string,
    serverName: string,
    payload: McpCredentialPayload,
  ): McpCredentialEnvelope {
    if (!userId || !serverName) {
      throw new ControlPlaneStateError("MCP credential owner and server must not be empty");
    }
    const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
    try {
      if (plaintext.length === 0 || plaintext.length > MAX_PAYLOAD_BYTES) {
        throw new ControlPlaneStateError(
          `MCP credential payload must contain 1 to ${MAX_PAYLOAD_BYTES} UTF-8 bytes`,
        );
      }
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv(CIPHER, this.key, nonce, { authTagLength: AUTH_TAG_BYTES });
      cipher.setAAD(additionalAuthenticatedData(userId, serverName, this.keyId));
      return {
        ciphertext: Buffer.concat([cipher.update(plaintext), cipher.final()]),
        nonce,
        authTag: cipher.getAuthTag(),
        keyId: this.keyId,
        formatVersion: FORMAT_VERSION,
      };
    } finally {
      plaintext.fill(0);
    }
  }

  decrypt(
    userId: string,
    serverName: string,
    envelope: McpCredentialEnvelope,
  ): McpCredentialPayload {
    if (envelope.formatVersion !== FORMAT_VERSION || envelope.keyId !== this.keyId) {
      throw new ControlPlaneStateError("MCP credential uses an unavailable format or key");
    }
    let plaintext: Buffer | undefined;
    try {
      const decipher = createDecipheriv(CIPHER, this.key, envelope.nonce, {
        authTagLength: AUTH_TAG_BYTES,
      });
      decipher.setAAD(additionalAuthenticatedData(userId, serverName, envelope.keyId));
      decipher.setAuthTag(envelope.authTag);
      plaintext = Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]);
      const parsed: unknown = JSON.parse(utf8Decoder.decode(plaintext));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !("kind" in parsed)) {
        throw new ControlPlaneStateError("MCP credential payload is invalid");
      }
      return parsed as McpCredentialPayload;
    } catch (error) {
      if (error instanceof ControlPlaneStateError) {
        throw error;
      }
      throw new ControlPlaneStateError("MCP credential decryption failed");
    } finally {
      plaintext?.fill(0);
    }
  }
}
