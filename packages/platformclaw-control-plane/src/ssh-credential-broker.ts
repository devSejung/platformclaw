import {
  OneShotCredentialGrantStore,
  type CredentialBrokerGrant,
} from "./credential-broker-grants.js";
import { LocalCredentialBrokerServer } from "./credential-broker-local.js";
import type { SshCredentialVault } from "./ssh-credential-vault.js";

export class SshCredentialBroker {
  private readonly grants = new OneShotCredentialGrantStore();
  private readonly server: LocalCredentialBrokerServer;

  constructor(
    address: string,
    private readonly vault: Pick<SshCredentialVault, "resolveForBroker">,
  ) {
    this.server = new LocalCredentialBrokerServer({ address, grants: this.grants });
  }

  issueForUser(userId: string): CredentialBrokerGrant {
    this.server.assertAvailable();
    return this.grants.issue(async () => this.vault.resolveForBroker(userId));
  }

  listen(): Promise<void> {
    return this.server.listen();
  }

  close(): Promise<void> {
    return this.server.close();
  }
}
