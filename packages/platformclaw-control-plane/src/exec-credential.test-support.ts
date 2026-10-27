import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserAuthService, hashBrowserSessionToken } from "./browser-auth-service.js";
import type { ControlPlaneIdFactory, PlatformUser } from "./contracts.js";
import { ExecCredentialCipher } from "./exec-credential-crypto.js";
import { ExecCredentialService } from "./exec-credential-service.js";
import { SqliteControlPlaneStore } from "./sqlite-store.js";

export async function createExecCredentialTestContext() {
  const directory = mkdtempSync(join(tmpdir(), "platformclaw-exec-credential-"));
  let sequence = 0;
  const ids: ControlPlaneIdFactory = {
    nextUserId: () => `user-${++sequence}`,
    nextBindingId: () => `binding-${++sequence}`,
    nextSessionId: () => `session-${++sequence}`,
    nextManagedScopeId: () => `scope-${++sequence}`,
    nextAuditEventId: () => `audit-${++sequence}`,
  };
  const store = new SqliteControlPlaneStore({
    databasePath: join(directory, "control.sqlite"),
    buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
    initialAdminAccountIds: ["admin.user"],
    idFactory: ids,
  });
  const authService = new BrowserAuthService({
    store,
    now: () => 100,
    authenticator: {
      authenticatePassword: async () => ({ status: "rejected", message: "unused" }),
    },
    provisioner: { provisionOrRefresh: async () => {} },
  });
  const cipher = ExecCredentialCipher.fromBase64(randomBytes(32).toString("base64"));
  const service = new ExecCredentialService({ store, cipher, authService, now: () => 100 });
  async function account(accountId: string) {
    const user = (
      await store.upsertPrincipal(
        {
          provider: "ldap",
          subject: `subject:${accountId}`,
          accountId,
          employeeId: accountId,
        },
        1,
      )
    ).user;
    const reserved = await store.reservePersonalAgent(user.id, 2);
    await store.transitionAgent({ bindingId: reserved.binding.id, state: "active", changedAt: 3 });
    const token = `synthetic-session-${accountId}`;
    const created = await store.createBrowserSession({
      userId: user.id,
      tokenHash: hashBrowserSessionToken(token),
      createdAt: 4,
    });
    if (created.status !== "created") {
      throw new Error("fixture session was not created");
    }
    return { user, token, agentId: reserved.binding.agentId, session: created.session };
  }
  const admin = await account("admin.user");
  const member = await account("member.user");
  async function preconditions(user: PlatformUser, envName: string) {
    const definition = (await store.listExecCredentialDefinitions(user.id)).find(
      (item) => item.envName === envName,
    );
    if (!definition) {
      throw new Error("fixture definition is missing");
    }
    return {
      expectedDefinitionToken: definition.definitionToken,
      expectedCredentialToken: definition.credentialToken,
    };
  }
  return {
    directory,
    store,
    authService,
    service,
    cipher,
    admin,
    member,
    account,
    preconditions,
    close() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
