export type SshCredentialEnvelope = {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  authTag: Uint8Array;
  keyId: string;
  formatVersion: 1;
};

export type StoredUserSshCredential = SshCredentialEnvelope & {
  id: string;
  userId: string;
  revision: number;
  status: "current" | "update_required";
  lastAuthFailureAt?: number;
  createdAt: number;
  updatedAt: number;
};

export type UserSshCredentialMetadata = Omit<
  StoredUserSshCredential,
  "ciphertext" | "nonce" | "authTag"
>;

export interface ControlPlaneSshCredentialEnvelopeStore {
  replaceEncryptedUserSshCredential(params: {
    actorUserId: string;
    userId: string;
    envelope: SshCredentialEnvelope;
    replacedAt: number;
  }): Promise<UserSshCredentialMetadata>;
  getUserSshCredentialMetadata(params: {
    actorUserId: string;
    userId: string;
  }): Promise<UserSshCredentialMetadata | null>;
  readEncryptedUserSshCredential(userId: string): Promise<StoredUserSshCredential | null>;
  markUserSshCredentialUpdateRequired(params: {
    userId: string;
    revision: number;
    failedAt: number;
  }): Promise<UserSshCredentialMetadata | null>;
  deleteUserSshCredential(params: {
    actorUserId: string;
    userId: string;
    deletedAt: number;
  }): Promise<boolean>;
}
