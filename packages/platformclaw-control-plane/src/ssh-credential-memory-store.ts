import { ControlPlaneAuthorizationError, ControlPlaneStateError } from "./contracts.js";
import { nextExecutionResourceId } from "./ids.js";
import type {
  ControlPlaneSshCredentialEnvelopeStore,
  StoredUserSshCredential,
  UserSshCredentialMetadata,
} from "./ssh-credential-contracts.js";
import { validateSshCredentialEnvelope } from "./ssh-credential-validation.js";

type InMemorySshCredentialEnvelopeStoreOptions = {
  idFactory: import("./contracts.js").ControlPlaneIdFactory;
  isActiveUser(userId: string): boolean;
  recordAudit(params: {
    actorUserId?: string;
    eventType: string;
    targetType: string;
    targetId: string;
    createdAt: number;
    details?: Record<string, unknown>;
  }): void;
};

function cloneStored(credential: StoredUserSshCredential): StoredUserSshCredential {
  return {
    ...credential,
    ciphertext: credential.ciphertext.slice(),
    nonce: credential.nonce.slice(),
    authTag: credential.authTag.slice(),
  };
}

function metadata(credential: StoredUserSshCredential): UserSshCredentialMetadata {
  const { ciphertext: _ciphertext, nonce: _nonce, authTag: _authTag, ...result } = credential;
  return { ...result };
}

export class InMemorySshCredentialEnvelopeStore implements ControlPlaneSshCredentialEnvelopeStore {
  private readonly credentials = new Map<string, StoredUserSshCredential>();

  constructor(private readonly options: InMemorySshCredentialEnvelopeStoreOptions) {}

  async replaceEncryptedUserSshCredential(
    params: Parameters<
      ControlPlaneSshCredentialEnvelopeStore["replaceEncryptedUserSshCredential"]
    >[0],
  ): Promise<UserSshCredentialMetadata> {
    this.requireSelf(params.actorUserId, params.userId);
    this.requireActiveUser(params.userId);
    validateSshCredentialEnvelope(params.envelope);
    const existing = this.credentials.get(params.userId);
    const stored: StoredUserSshCredential = {
      id: existing?.id ?? nextExecutionResourceId(this.options.idFactory, "ssh-credential"),
      userId: params.userId,
      ciphertext: params.envelope.ciphertext.slice(),
      nonce: params.envelope.nonce.slice(),
      authTag: params.envelope.authTag.slice(),
      keyId: params.envelope.keyId,
      formatVersion: params.envelope.formatVersion,
      revision: (existing?.revision ?? 0) + 1,
      status: "current",
      createdAt: existing?.createdAt ?? params.replacedAt,
      updatedAt: params.replacedAt,
    };
    this.credentials.set(params.userId, stored);
    this.options.recordAudit({
      actorUserId: params.actorUserId,
      eventType: existing ? "ssh-credential.replaced" : "ssh-credential.created",
      targetType: "ssh-credential",
      targetId: stored.id,
      createdAt: params.replacedAt,
      details: { revision: stored.revision },
    });
    return metadata(stored);
  }

  async getUserSshCredentialMetadata(
    params: Parameters<ControlPlaneSshCredentialEnvelopeStore["getUserSshCredentialMetadata"]>[0],
  ): Promise<UserSshCredentialMetadata | null> {
    this.requireSelf(params.actorUserId, params.userId);
    this.requireActiveUser(params.userId);
    const stored = this.credentials.get(params.userId);
    return stored ? metadata(stored) : null;
  }

  async readEncryptedUserSshCredential(userId: string): Promise<StoredUserSshCredential | null> {
    const stored = this.credentials.get(userId);
    if (stored && !this.options.isActiveUser(userId)) {
      throw new ControlPlaneStateError("active user required for SSH credential resolution");
    }
    return stored ? cloneStored(stored) : null;
  }

  async markUserSshCredentialUpdateRequired(
    params: Parameters<
      ControlPlaneSshCredentialEnvelopeStore["markUserSshCredentialUpdateRequired"]
    >[0],
  ): Promise<UserSshCredentialMetadata | null> {
    const stored = this.credentials.get(params.userId);
    if (!stored) {
      return null;
    }
    if (stored.revision !== params.revision) {
      return metadata(stored);
    }
    stored.status = "update_required";
    stored.lastAuthFailureAt = params.failedAt;
    stored.updatedAt = params.failedAt;
    this.options.recordAudit({
      eventType: "ssh-credential.update-required",
      targetType: "ssh-credential",
      targetId: stored.id,
      createdAt: params.failedAt,
      details: { revision: stored.revision },
    });
    return metadata(stored);
  }

  async deleteUserSshCredential(
    params: Parameters<ControlPlaneSshCredentialEnvelopeStore["deleteUserSshCredential"]>[0],
  ): Promise<boolean> {
    this.requireSelf(params.actorUserId, params.userId);
    this.requireActiveUser(params.userId);
    const stored = this.credentials.get(params.userId);
    if (!stored) {
      return false;
    }
    this.credentials.delete(params.userId);
    this.options.recordAudit({
      actorUserId: params.actorUserId,
      eventType: "ssh-credential.deleted",
      targetType: "ssh-credential",
      targetId: stored.id,
      createdAt: params.deletedAt,
      details: { revision: stored.revision },
    });
    return true;
  }

  private requireSelf(actorUserId: string, userId: string): void {
    if (actorUserId !== userId) {
      throw new ControlPlaneAuthorizationError("users may manage only their own SSH credential");
    }
  }

  private requireActiveUser(userId: string): void {
    if (!this.options.isActiveUser(userId)) {
      throw new ControlPlaneStateError("active user required for SSH credential management");
    }
  }
}

export abstract class InMemorySshCredentialStoreBase implements ControlPlaneSshCredentialEnvelopeStore {
  private readonly credentialEnvelopeStore: InMemorySshCredentialEnvelopeStore;

  protected constructor(idFactory: import("./contracts.js").ControlPlaneIdFactory) {
    this.credentialEnvelopeStore = new InMemorySshCredentialEnvelopeStore({
      idFactory,
      isActiveUser: (userId) => this.isActiveCredentialUser(userId),
      recordAudit: (params) => this.recordCredentialAudit(params),
    });
  }

  replaceEncryptedUserSshCredential(
    params: Parameters<
      ControlPlaneSshCredentialEnvelopeStore["replaceEncryptedUserSshCredential"]
    >[0],
  ): Promise<UserSshCredentialMetadata> {
    return this.credentialEnvelopeStore.replaceEncryptedUserSshCredential(params);
  }

  getUserSshCredentialMetadata(
    params: Parameters<ControlPlaneSshCredentialEnvelopeStore["getUserSshCredentialMetadata"]>[0],
  ): Promise<UserSshCredentialMetadata | null> {
    return this.credentialEnvelopeStore.getUserSshCredentialMetadata(params);
  }

  readEncryptedUserSshCredential(userId: string): Promise<StoredUserSshCredential | null> {
    return this.credentialEnvelopeStore.readEncryptedUserSshCredential(userId);
  }

  markUserSshCredentialUpdateRequired(
    params: Parameters<
      ControlPlaneSshCredentialEnvelopeStore["markUserSshCredentialUpdateRequired"]
    >[0],
  ): Promise<UserSshCredentialMetadata | null> {
    return this.credentialEnvelopeStore.markUserSshCredentialUpdateRequired(params);
  }

  deleteUserSshCredential(
    params: Parameters<ControlPlaneSshCredentialEnvelopeStore["deleteUserSshCredential"]>[0],
  ): Promise<boolean> {
    return this.credentialEnvelopeStore.deleteUserSshCredential(params);
  }

  protected abstract isActiveCredentialUser(userId: string): boolean;
  protected abstract recordCredentialAudit(
    params: Parameters<InMemorySshCredentialEnvelopeStoreOptions["recordAudit"]>[0],
  ): void;
}
