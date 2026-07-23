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
import type { SshCredentialEnvelope } from "./ssh-credential-contracts.js";

const CIPHER = "aes-256-gcm";
const FORMAT_VERSION = 1 as const;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const MAX_PASSWORD_BYTES = 8 * 1024;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function decodeCanonicalBase64(value: string): Buffer {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(normalized) || normalized.length % 4 !== 0) {
    throw new ControlPlaneStateError("SSH credential master key must be canonical Base64");
  }
  const decoded = Buffer.from(normalized, "base64");
  if (decoded.toString("base64") !== normalized) {
    decoded.fill(0);
    throw new ControlPlaneStateError("SSH credential master key must be canonical Base64");
  }
  return decoded;
}

function additionalAuthenticatedData(userId: string, keyId: string): Buffer {
  return Buffer.from(`platformclaw:ssh-credential:v${FORMAT_VERSION}\0${userId}\0${keyId}`, "utf8");
}

export class SshCredentialCipher {
  readonly keyId: string;
  private readonly key: KeyObject;

  private constructor(key: KeyObject, keyId: string) {
    this.key = key;
    this.keyId = keyId;
  }

  static fromBase64(masterKeyBase64: string): SshCredentialCipher {
    const keyBytes = decodeCanonicalBase64(masterKeyBase64);
    try {
      if (keyBytes.length !== 32) {
        throw new ControlPlaneStateError("SSH credential master key must decode to 32 bytes");
      }
      const keyId = `sha256:${createHash("sha256").update(keyBytes).digest("base64url")}`;
      return new SshCredentialCipher(createSecretKey(keyBytes), keyId);
    } finally {
      keyBytes.fill(0);
    }
  }

  encrypt(userId: string, password: string): SshCredentialEnvelope {
    if (!userId) {
      throw new ControlPlaneStateError("credential user id must not be empty");
    }
    const plaintext = Buffer.from(password, "utf8");
    try {
      if (plaintext.length === 0 || plaintext.length > MAX_PASSWORD_BYTES) {
        throw new ControlPlaneStateError(
          `SSH credential password must contain 1 to ${MAX_PASSWORD_BYTES} UTF-8 bytes`,
        );
      }
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv(CIPHER, this.key, nonce, { authTagLength: AUTH_TAG_BYTES });
      cipher.setAAD(additionalAuthenticatedData(userId, this.keyId));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return {
        ciphertext,
        nonce,
        authTag: cipher.getAuthTag(),
        keyId: this.keyId,
        formatVersion: FORMAT_VERSION,
      };
    } finally {
      plaintext.fill(0);
    }
  }

  decrypt(userId: string, envelope: SshCredentialEnvelope): string {
    if (envelope.formatVersion !== FORMAT_VERSION) {
      throw new ControlPlaneStateError(
        `unsupported SSH credential format version: ${String(envelope.formatVersion)}`,
      );
    }
    if (envelope.keyId !== this.keyId) {
      throw new ControlPlaneStateError(
        "SSH credential was encrypted with an unavailable master key",
      );
    }
    try {
      const decipher = createDecipheriv(CIPHER, this.key, envelope.nonce, {
        authTagLength: AUTH_TAG_BYTES,
      });
      decipher.setAAD(additionalAuthenticatedData(userId, envelope.keyId));
      decipher.setAuthTag(envelope.authTag);
      const plaintext = Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]);
      try {
        return utf8Decoder.decode(plaintext);
      } finally {
        plaintext.fill(0);
      }
    } catch (error) {
      if (error instanceof ControlPlaneStateError) {
        throw error;
      }
      throw new ControlPlaneStateError("SSH credential decryption failed");
    }
  }
}
