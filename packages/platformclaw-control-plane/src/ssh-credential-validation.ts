import { ControlPlaneStateError } from "./contracts.js";
import type { SshCredentialEnvelope } from "./ssh-credential-contracts.js";

export function validateSshCredentialEnvelope(envelope: SshCredentialEnvelope): void {
  if (envelope.formatVersion !== 1) {
    throw new ControlPlaneStateError(
      `unsupported SSH credential format version: ${String(envelope.formatVersion)}`,
    );
  }
  if (!/^sha256:[A-Za-z0-9_-]{43}$/u.test(envelope.keyId)) {
    throw new ControlPlaneStateError("SSH credential key id is invalid");
  }
  if (envelope.ciphertext.length === 0) {
    throw new ControlPlaneStateError("SSH credential ciphertext must not be empty");
  }
  if (envelope.nonce.length !== 12) {
    throw new ControlPlaneStateError("SSH credential nonce must contain 12 bytes");
  }
  if (envelope.authTag.length !== 16) {
    throw new ControlPlaneStateError("SSH credential authentication tag must contain 16 bytes");
  }
}
