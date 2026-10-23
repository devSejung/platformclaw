import { createHash } from "node:crypto";
import type { StoredUserMcpCredential } from "./mcp-credential-contracts.js";

export function mcpCredentialFingerprint(credential: StoredUserMcpCredential): string {
  // Ciphertext and nonce distinguish deletion/recreation even when the numeric
  // revision restarts. Hash the encrypted envelope, never low-entropy plaintext.
  return createHash("sha256")
    .update(
      JSON.stringify([
        credential.userId,
        credential.serverName,
        credential.kind,
        credential.revision,
        credential.createdAt,
        credential.updatedAt,
        credential.formatVersion,
        credential.keyId,
        Buffer.from(credential.ciphertext).toString("base64"),
        Buffer.from(credential.nonce).toString("base64"),
        Buffer.from(credential.authTag).toString("base64"),
      ]),
    )
    .digest("hex");
}
