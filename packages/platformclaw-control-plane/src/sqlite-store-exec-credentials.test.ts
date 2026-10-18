import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserAuthService } from "./browser-auth-service.js";
import type { ControlPlaneIdFactory, EnterprisePrincipal } from "./contracts.js";
import { ExecCredentialCipher } from "./exec-credential-crypto.js";
import { ExecCredentialService } from "./exec-credential-service.js";
import { SqliteControlPlaneStore } from "./sqlite-store.js";

const temporaryDirectories: string[] = [];

function ids(): ControlPlaneIdFactory {
  let sequence = 0;
  return {
    nextUserId: () => `user-${++sequence}`,
    nextBindingId: () => `binding-${++sequence}`,
    nextSessionId: () => `session-${++sequence}`,
    nextManagedScopeId: () => `scope-${++sequence}`,
    nextAuditEventId: () => `audit-${++sequence}`,
  };
}

function principal(accountId: string): EnterprisePrincipal {
  return { provider: "ldap", subject: `subject:${accountId}`, accountId, employeeId: accountId };
}

function store(): SqliteControlPlaneStore {
  const directory = mkdtempSync(join(tmpdir(), "platformclaw-exec-credential-"));
  temporaryDirectories.push(directory);
  return new SqliteControlPlaneStore({
    databasePath: join(directory, "control.sqlite"),
    buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
    initialAdminAccountIds: ["admin.user"],
    idFactory: ids(),
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SqliteControlPlaneExecCredentialStore", () => {
  it("reads only authorized metadata without decrypting values and rechecks lifecycle changes", async () => {
    const control = store();
    try {
      const admin = (await control.upsertPrincipal(principal("admin.user"), 1)).user;
      const member = (await control.upsertPrincipal(principal("member.user"), 2)).user;
      const reserved = await control.reservePersonalAgent(member.id, 3);
      const agentId = reserved.binding.agentId;
      const sessionKey = `agent:${agentId}:dashboard:synthetic`;
      const cipher = ExecCredentialCipher.fromBase64(randomBytes(32).toString("base64"));
      const decrypt = vi.spyOn(cipher, "decrypt");
      const service = new ExecCredentialService({
        store: control,
        cipher,
        authService: {} as BrowserAuthService,
      });
      await control.addExecCredentialDefinition(admin.id, "REPORT_API_TOKEN", 4);
      expect(await service.metadataForAgent(agentId, sessionKey)).toEqual({
        status: "unsupported",
        code: "scope",
      });
      await control.transitionAgent({
        bindingId: reserved.binding.id,
        state: "active",
        changedAt: 5,
      });
      expect(await service.metadataForAgent(agentId, sessionKey)).toEqual({
        definitions: [{ envName: "REPORT_API_TOKEN", configured: false }],
      });
      await service.replace(member.id, "REPORT_API_TOKEN", "synthetic-value");
      expect(await service.metadataForAgent(agentId, sessionKey)).toEqual({
        definitions: [
          {
            envName: "REPORT_API_TOKEN",
            configured: true,
            revision: 1,
            updatedAt: expect.any(Number),
          },
        ],
      });
      for (const key of [
        "catalog-one",
        "agent:other:main",
        `agent:${agentId}:space-session:one`,
        `agent:${agentId}:subagent:one`,
        `agent:${agentId}:acp:one`,
        `agent:${agentId}:knox:group:one`,
      ]) {
        expect(await service.metadataForAgent(agentId, key)).toEqual({
          status: "unsupported",
          code: "scope",
        });
      }
      expect(await service.metadataForAgent("room-agent", "agent:room-agent:main")).toEqual({
        status: "unsupported",
        code: "scope",
      });
      await control.removeExecCredentialDefinition(admin.id, "REPORT_API_TOKEN", 8);
      expect(await service.metadataForAgent(agentId, sessionKey)).toEqual({ definitions: [] });
      await control.setManagedUserStatus({
        actorUserId: admin.id,
        targetUserId: member.id,
        status: "disabled",
        changedAt: 9,
      });
      expect(await service.metadataForAgent(agentId, sessionKey)).toEqual({
        status: "unsupported",
        code: "scope",
      });
      expect(decrypt).not.toHaveBeenCalled();
    } finally {
      control.close();
    }
  });

  it("resolves encrypted values only through the active personal agent owner", async () => {
    const control = store();
    const admin = (await control.upsertPrincipal(principal("admin.user"), 1)).user;
    const member = (await control.upsertPrincipal(principal("member.user"), 2)).user;
    const reserved = await control.reservePersonalAgent(member.id, 3);
    await control.transitionAgent({
      bindingId: reserved.binding.id,
      state: "active",
      changedAt: 4,
    });
    const cipher = ExecCredentialCipher.fromBase64(randomBytes(32).toString("base64"));
    await control.addExecCredentialDefinition(admin.id, "API_TOKEN", 5);
    await control.replaceExecCredential({
      actorUserId: member.id,
      envName: "API_TOKEN",
      envelope: cipher.encrypt(member.id, "API_TOKEN", "member-secret"),
      updatedAt: 6,
    });

    const rows = await control.readExecCredentialsForAgent(reserved.binding.agentId);
    expect(rows).toHaveLength(1);
    expect(cipher.decrypt(member.id, "API_TOKEN", rows[0]!)).toBe("member-secret");
    await expect(control.readExecCredentialsForAgent("room-agent")).resolves.toEqual([]);

    await control.removeExecCredentialDefinition(admin.id, "API_TOKEN", 7);
    await expect(control.readExecCredentialsForAgent(reserved.binding.agentId)).resolves.toEqual(
      [],
    );
    control.close();
  });
});
