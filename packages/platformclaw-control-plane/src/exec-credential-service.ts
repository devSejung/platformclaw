import type { BrowserAuthService } from "./browser-auth-service.js";
import { ControlPlaneAuthorizationError } from "./contracts.js";
import { normalizeExecEnvName } from "./exec-credential-contracts.js";
import { ExecCredentialCipher } from "./exec-credential-crypto.js";
import type { SqliteControlPlaneStore } from "./sqlite-store.js";

export class ExecCredentialService {
  constructor(
    private readonly options: {
      authService: BrowserAuthService;
      store: SqliteControlPlaneStore;
      cipher: ExecCredentialCipher;
      now?: () => number;
    },
  ) {}

  async authenticate(token: string) {
    const auth = await this.options.authService.authenticateToken(token);
    return auth.status === "active" ? auth : null;
  }

  async snapshot(userId: string) {
    return { definitions: await this.options.store.listExecCredentialDefinitions(userId) };
  }

  async adminSnapshot(actorUserId: string) {
    const actor = await this.options.store.getUserById(actorUserId);
    if (actor?.globalRole !== "admin") {
      throw new ControlPlaneAuthorizationError("administrator required");
    }
    return { definitions: await this.options.store.listExecCredentialDefinitions() };
  }

  async addDefinition(actorUserId: string, envName: string) {
    await this.options.store.addExecCredentialDefinition(
      actorUserId,
      envName,
      (this.options.now ?? Date.now)(),
    );
    return this.adminSnapshot(actorUserId);
  }

  async removeDefinition(actorUserId: string, envName: string) {
    await this.options.store.removeExecCredentialDefinition(
      actorUserId,
      envName,
      (this.options.now ?? Date.now)(),
    );
    return this.adminSnapshot(actorUserId);
  }

  async replace(userId: string, rawName: string, value: string) {
    const envName = normalizeExecEnvName(rawName);
    const envelope = this.options.cipher.encrypt(userId, envName, value);
    const revision = await this.options.store.replaceExecCredential({
      actorUserId: userId,
      envName,
      envelope,
      updatedAt: (this.options.now ?? Date.now)(),
    });
    return { envName, revision };
  }

  async remove(userId: string, envName: string) {
    return {
      deleted: await this.options.store.deleteExecCredential(
        userId,
        envName,
        (this.options.now ?? Date.now)(),
      ),
    };
  }

  async resolveForAgent(agentId: string): Promise<Record<string, string>> {
    const rows = await this.options.store.readExecCredentialsForAgent(agentId);
    return Object.fromEntries(
      rows.map((row) => [row.envName, this.options.cipher.decrypt(row.userId, row.envName, row)]),
    );
  }
}
