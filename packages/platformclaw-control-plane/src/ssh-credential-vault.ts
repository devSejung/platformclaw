import { ControlPlaneStateError } from "./contracts.js";
import type {
  ControlPlaneSshCredentialEnvelopeStore,
  UserSshCredentialMetadata,
} from "./ssh-credential-contracts.js";
import { SshCredentialCipher } from "./ssh-credential-crypto.js";

export type ResolvedUserSshCredential = {
  password: Buffer;
  revision: number;
};

export class SshCredentialVault {
  constructor(
    private readonly store: ControlPlaneSshCredentialEnvelopeStore,
    private readonly cipher: SshCredentialCipher,
  ) {}

  replace(params: {
    actorUserId: string;
    userId: string;
    password: string;
    replacedAt: number;
  }): Promise<UserSshCredentialMetadata> {
    const envelope = this.cipher.encrypt(params.userId, params.password);
    return this.store.replaceEncryptedUserSshCredential({
      actorUserId: params.actorUserId,
      userId: params.userId,
      envelope,
      replacedAt: params.replacedAt,
    });
  }

  getMetadata(params: {
    actorUserId: string;
    userId: string;
  }): Promise<UserSshCredentialMetadata | null> {
    return this.store.getUserSshCredentialMetadata(params);
  }

  async resolveForBroker(userId: string): Promise<ResolvedUserSshCredential> {
    const stored = await this.store.readEncryptedUserSshCredential(userId);
    if (!stored) {
      throw new ControlPlaneStateError("SSH credential is not configured");
    }
    if (stored.status !== "current") {
      throw new ControlPlaneStateError("SSH credential requires an update");
    }
    return {
      password: this.cipher.decryptBytes(userId, stored),
      revision: stored.revision,
    };
  }

  markUpdateRequired(params: {
    userId: string;
    revision: number;
    failedAt: number;
  }): Promise<UserSshCredentialMetadata | null> {
    return this.store.markUserSshCredentialUpdateRequired(params);
  }

  delete(params: { actorUserId: string; userId: string; deletedAt: number }): Promise<boolean> {
    return this.store.deleteUserSshCredential(params);
  }
}
