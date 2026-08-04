import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runPlatformClawAdminCli } from "./admin-cli.js";
import type { EnterprisePrincipal } from "./contracts.js";
import { SqliteControlPlaneStore } from "./sqlite-store.js";

const temporaryDirectories: string[] = [];

function createDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "platformclaw-admin-cli-"));
  temporaryDirectories.push(directory);
  return join(directory, "platformclaw-control.sqlite");
}

function principal(accountId: string): EnterprisePrincipal {
  return {
    provider: "ldap",
    subject: `subject:${accountId}`,
    accountId,
    employeeId: accountId,
  };
}

function openStore(databasePath: string, initialAdminAccountIds: readonly string[] = []) {
  return new SqliteControlPlaneStore({
    databasePath,
    buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
    initialAdminAccountIds,
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("PlatformClaw administrator CLI", () => {
  it("promotes one existing active account and records the deployment actor", async () => {
    const databasePath = createDatabasePath();
    const seed = openStore(databasePath, ["admin.user"]);
    await seed.upsertPrincipal(principal("admin.user"), 1_000);
    const member = await seed.upsertPrincipal(principal("member.user"), 1_001);
    seed.close();

    const output: string[] = [];
    await runPlatformClawAdminCli({
      argv: ["add", "MEMBER.USER"],
      env: { PLATFORMCLAW_DATABASE_PATH: databasePath },
      now: () => 2_000,
      write: (message) => output.push(message),
    });

    const verify = openStore(databasePath);
    await expect(verify.getUserByAccountId("member.user")).resolves.toMatchObject({
      globalRole: "admin",
      updatedAt: 2_000,
    });
    await expect(verify.listAuditEvents()).resolves.toContainEqual(
      expect.objectContaining({
        eventType: "user.role.changed",
        targetId: member.user.id,
        details: { from: "member", to: "admin", source: "deployment-operator" },
      }),
    );
    expect(output).toEqual(["PlatformClaw administrator added: member.user\n"]);
    verify.close();
  });

  it("is idempotent for an existing administrator", async () => {
    const databasePath = createDatabasePath();
    const seed = openStore(databasePath, ["admin.user"]);
    await seed.upsertPrincipal(principal("admin.user"), 1_000);
    seed.close();

    const output: string[] = [];
    await runPlatformClawAdminCli({
      argv: ["add", "admin.user"],
      env: { PLATFORMCLAW_DATABASE_PATH: databasePath },
      write: (message) => output.push(message),
    });

    const verify = openStore(databasePath);
    expect(
      (await verify.listAuditEvents()).filter((event) => event.eventType === "user.role.changed"),
    ).toHaveLength(0);
    expect(output).toEqual(["PlatformClaw administrator already exists: admin.user\n"]);
    verify.close();
  });

  it("rejects missing, unknown, and disabled accounts", async () => {
    const databasePath = createDatabasePath();
    const seed = openStore(databasePath, ["admin.user"]);
    const admin = await seed.upsertPrincipal(principal("admin.user"), 1_000);
    const disabled = await seed.upsertPrincipal(principal("disabled.user"), 1_001);
    await seed.setManagedUserStatus({
      actorUserId: admin.user.id,
      targetUserId: disabled.user.id,
      status: "disabled",
      changedAt: 1_002,
    });
    seed.close();

    await expect(
      runPlatformClawAdminCli({ argv: [], env: { PLATFORMCLAW_DATABASE_PATH: databasePath } }),
    ).rejects.toThrow("usage: platformclaw-admin add <account-id>");
    await expect(
      runPlatformClawAdminCli({
        argv: ["add", "missing.user"],
        env: { PLATFORMCLAW_DATABASE_PATH: databasePath },
      }),
    ).rejects.toThrow("user not found: missing.user");
    await expect(
      runPlatformClawAdminCli({
        argv: ["add", "disabled.user"],
        env: { PLATFORMCLAW_DATABASE_PATH: databasePath },
      }),
    ).rejects.toThrow("cannot promote a disabled user: disabled.user");
  });
});
