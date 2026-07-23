import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import {
  OneShotCredentialGrantStore,
  type CredentialBrokerGrant,
} from "./credential-broker-grants.js";
import { LocalCredentialBrokerServer } from "./credential-broker-local.js";
import type { SshCredentialVault } from "./ssh-credential-vault.js";

const RUNTIME_ADDRESS_NONCE_BYTES = 6;
const MAX_UNIX_SOCKET_PATH_BYTES = 103;

function appendRuntimeNonce(address: string, nonce: string): string {
  if (process.platform === "win32") {
    return `${address}-${nonce}`;
  }
  const runtimeAddress = join(dirname(address), `${nonce}.sock`);
  // 103 bytes is the conservative sockaddr_un pathname limit across the
  // supported Unix hosts. Reject the configured directory before bind(2).
  if (Buffer.byteLength(runtimeAddress) > MAX_UNIX_SOCKET_PATH_BYTES) {
    throw new Error("credential broker runtime directory path is too long");
  }
  return runtimeAddress;
}

/**
 * Give every control-process lifetime a fresh broker address. A crashed
 * process may leave a socket inode behind, so reusing one fixed name would
 * turn a safe Control-only restart into a permanent restart loop.
 */
export function createCredentialBrokerRuntimeAddress(
  baseAddress: string,
  nonce = randomBytes(RUNTIME_ADDRESS_NONCE_BYTES).toString("base64url"),
): string {
  if (!/^[A-Za-z0-9_-]{8}$/u.test(nonce)) {
    throw new Error("credential broker runtime nonce is invalid");
  }
  return appendRuntimeNonce(baseAddress, nonce);
}

export class SshCredentialBroker {
  private readonly grants = new OneShotCredentialGrantStore();
  private readonly server: LocalCredentialBrokerServer;
  readonly address: string;

  constructor(
    baseAddress: string,
    private readonly vault: Pick<SshCredentialVault, "resolveForBroker">,
    options: { runtimeNonce?: string } = {},
  ) {
    this.address = createCredentialBrokerRuntimeAddress(baseAddress, options.runtimeNonce);
    this.server = new LocalCredentialBrokerServer({ address: this.address, grants: this.grants });
  }

  issueForUser(userId: string, validate?: () => Promise<void>): CredentialBrokerGrant {
    this.server.assertAvailable();
    return this.grants.issue(async () => {
      await validate?.();
      return this.vault.resolveForBroker(userId);
    });
  }

  listen(): Promise<void> {
    return this.server.listen();
  }

  close(): Promise<void> {
    return this.server.close();
  }
}
