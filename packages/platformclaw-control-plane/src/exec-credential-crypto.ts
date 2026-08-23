import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createSecretKey,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { ControlPlaneStateError } from "./contracts.js";
import {
  EXEC_CREDENTIAL_LIMITS,
  type ExecCredentialEnvelope,
} from "./exec-credential-contracts.js";

const CIPHER = "aes-256-gcm";
const FORMAT_VERSION = 1 as const;

function decodeKey(value: string): Buffer {
  const normalized = value.trim();
  const decoded = Buffer.from(normalized, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== normalized) {
    decoded.fill(0);
    throw new ControlPlaneStateError("exec credential master key must be canonical 32-byte Base64");
  }
  return decoded;
}

function aad(userId: string, envName: string, keyId: string): Buffer {
  return Buffer.from(`platformclaw:exec-credential:v1\0${userId}\0${envName}\0${keyId}`, "utf8");
}

export class ExecCredentialCipher {
  readonly keyId: string;
  private constructor(
    private readonly key: KeyObject,
    keyId: string,
  ) {
    this.keyId = keyId;
  }

  static fromBase64(value: string): ExecCredentialCipher {
    const bytes = decodeKey(value);
    try {
      const keyId = `sha256:${createHash("sha256").update(bytes).digest("base64url")}`;
      return new ExecCredentialCipher(createSecretKey(bytes), keyId);
    } finally {
      bytes.fill(0);
    }
  }

  encrypt(userId: string, envName: string, value: string): ExecCredentialEnvelope {
    const plaintext = Buffer.from(value, "utf8");
    try {
      if (
        !value ||
        value.includes("\0") ||
        value.includes("\r") ||
        value.includes("\n") ||
        plaintext.length > EXEC_CREDENTIAL_LIMITS.valueBytes
      ) {
        throw new ControlPlaneStateError("exec credential value is invalid");
      }
      const nonce = randomBytes(12);
      const cipher = createCipheriv(CIPHER, this.key, nonce);
      cipher.setAAD(aad(userId, envName, this.keyId));
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

  decrypt(userId: string, envName: string, envelope: ExecCredentialEnvelope): string {
    if (envelope.formatVersion !== FORMAT_VERSION || envelope.keyId !== this.keyId) {
      throw new ControlPlaneStateError("exec credential uses an unavailable format or key");
    }
    let plaintext: Buffer | undefined;
    try {
      const decipher = createDecipheriv(CIPHER, this.key, envelope.nonce);
      decipher.setAAD(aad(userId, envName, envelope.keyId));
      decipher.setAuthTag(envelope.authTag);
      plaintext = Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]);
      const value = plaintext.toString("utf8");
      if (!value || Buffer.byteLength(value, "utf8") !== plaintext.length) {
        throw new Error("invalid UTF-8");
      }
      return value;
    } catch {
      throw new ControlPlaneStateError("exec credential decryption failed");
    } finally {
      plaintext?.fill(0);
    }
  }
}
