import { randomUUID } from "node:crypto";
import path from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { BrowserAuthService, hashBrowserSessionToken } from "./browser-auth-service.js";
import { OrganizationService } from "./organization-service.js";
import type { SkillHubVersion } from "./skill-hub-adapter.js";
import { SkillHubService } from "./skill-hub-service.js";
import { createSkillHubServiceFixture as fixture } from "./skill-hub-service.test-fixtures.js";
import { ensureSkillHubStateSchema } from "./sqlite-schema.js";
import { SqliteControlPlaneStore } from "./sqlite-store.js";

function permutations<T>(items: readonly T[]): T[][] {
  return items.length === 0
    ? [[]]
    : items.flatMap((item, index) =>
        permutations(items.filter((_, other) => other !== index)).map((rest) =>
          [item].concat(rest),
        ),
      );
}

const history: SkillHubVersion[] = [
  { id: 10, version: "10.0.0", status: "PUBLISHED", downloadAvailable: true },
  { id: 20, version: "2.0.0", status: "PUBLISHED", downloadAvailable: true },
  { id: 30, version: "3.0.0", status: "PUBLISHED", downloadAvailable: true },
  { id: 40, version: "4.0.0", status: "PUBLISHED", downloadAvailable: true },
];

const context = (agentId: string) => ({
  accountId: "default",
  conversationType: "dm" as const,
  conversationId: "42",
  agentId,
  sessionKey: `agent:${agentId}:main`,
});

async function archive(version: string) {
  const zip = new JSZip();
  zip.file(
    "SKILL.md",
    `---\nname: demo-skill\ndescription: Chosen version\nversion: ${version}\n---\nInstructions`,
  );
  return await zip.generateAsync({ type: "nodebuffer" });
}

describe("Skill Hub canonical version selection", () => {
  it.each(
    permutations(history).map((order) => [order.map((item) => item.id).join(","), order] as const),
  )(
    "keeps current first and remaining IDs descending for registry order %s",
    async (_label, order) => {
      const f = await fixture([], undefined, { registrySkill: "absent" });
      const entry = await f.seedEntry({ version: "2.0.0" });
      const original = structuredClone(order);
      f.adapterMocks.listVersions.mockResolvedValue(order);
      const detail = await f.service.detailById(f.actor.user, entry.id);
      expect(detail.versions.map((version) => version.id)).toEqual([20, 40, 30, 10]);
      expect(detail.skill.latestVersion).toBe("2.0.0");
      expect((await f.service.resolveCommandSkill(f.actor.user, entry.id)).version).toBe("2.0.0");
      expect(order).toEqual(original);
    },
  );

  it("uses the most recently completed publication even when its SemVer is lower", async () => {
    const f = await fixture();
    const entry = f.entry!;
    f.nativeVersions.set(`${entry.namespace}/${entry.slug}`, new Set(["1.0.0"]));
    for (const version of ["10.0.0", "2.0.0"]) {
      const current = (await f.store.skillHubCatalog.get(entry.id))!;
      await f.service.publish(f.actor, {
        operationId: randomUUID(),
        id: entry.id,
        expectedRevision: current.revision,
        skill: entry.slug,
        version,
      });
    }
    const detail = await f.service.detailById(f.actor.user, entry.id);
    expect(detail.skill.latestVersion).toBe("2.0.0");
    expect(detail.versions.map((item) => item.version)).toEqual(["2.0.0", "10.0.0", "1.0.0"]);
    expect((await f.service.resolveCommandSkill(f.actor.user, entry.id)).version).toBe("2.0.0");
  });

  it.each(["warning", "failed"] as const)(
    "keeps the current %s scan in the headline without blocking valid bytes",
    async (state) => {
      const f = await fixture([], undefined, { registrySkill: "absent" });
      const entry = await f.seedEntry({ version: "2.0.0" });
      f.adapterMocks.listVersions.mockResolvedValue(history);
      f.adapterMocks.listSecurityAudits.mockImplementation(async (_skillId, versionId) =>
        versionId === 20
          ? [
              {
                scannerType: "SKILL_SCANNER",
                verdict: "SUSPICIOUS",
                isSafe: false,
                ...(state === "warning"
                  ? { scannedAt: "2026-10-28T00:00:00Z" }
                  : { failedAt: "2026-10-28T00:00:00Z" }),
              },
            ]
          : [],
      );
      const detail = await f.service.detailById(f.actor.user, entry.id);
      expect(detail.scanner).toEqual(
        detail.versions.find((item) => item.version === "2.0.0")!.scanner,
      );
      expect(detail.scanner.status).toBe(state === "warning" ? "warning" : "unverified");
      expect(detail.versions[0]).toMatchObject({ version: "2.0.0", downloadAvailable: true });
      expect((await f.service.resolveCommandSkill(f.actor.user, entry.id)).version).toBe("2.0.0");
    },
  );

  it.each(["unavailable", "yanked", "malware"] as const)(
    "retains the %s current row and selects the newest downloadable alternative",
    async (state) => {
      const f = await fixture([], undefined, { registrySkill: "absent" });
      const entry = await f.seedEntry({ version: "2.0.0" });
      f.adapterMocks.listVersions.mockResolvedValue(
        history.map((item) =>
          item.id === 20 && state === "yanked"
            ? Object.assign({}, item, { status: "YANKED" })
            : item,
        ),
      );
      f.governanceMocks.getArtifactSecurity.mockImplementation(async (identity) => ({
        audits: [],
        artifactAvailable: identity.versionId !== 20,
        blocked: identity.versionId === 20 && state === "malware",
      }));
      const detail = await f.service.detailById(f.actor.user, entry.id);
      expect(detail.versions.map((item) => item.id)).toEqual([20, 40, 30, 10]);
      expect(detail.versions[0]).toMatchObject({
        version: "2.0.0",
        downloadAvailable: false,
        ...(state === "yanked" ? { status: "YANKED" } : {}),
      });
      expect(detail.scanner).toEqual(detail.versions[0]!.scanner);
      expect((await f.service.resolveCommandSkill(f.actor.user, entry.id)).version).toBe("4.0.0");
      await expect(f.service.download(f.actor.user, entry.id, "2.0.0")).rejects.toMatchObject({
        statusCode: 409,
        details: {
          code: state === "malware" ? "skill-hub-version-blocked" : "skill-hub-version-unavailable",
        },
      });
      expect(f.adapterMocks.download).not.toHaveBeenCalled();
      expect(await f.store.skillHubCatalog.getBlockedVersions(entry.id)).toEqual(
        state === "malware" ? ["2.0.0"] : [],
      );
    },
  );

  it("fails visibly without an install effect when every artifact is unavailable", async () => {
    const f = await fixture();
    f.governanceMocks.getArtifactSecurity.mockResolvedValue({
      audits: [],
      artifactAvailable: false,
      blocked: false,
    });
    await expect(f.service.resolveCommandSkill(f.actor.user, f.entry!.id)).rejects.toMatchObject({
      statusCode: 409,
      details: { code: "skill-hub-command-no-download" },
    });
    expect(f.adapterMocks.download).not.toHaveBeenCalled();
    expect(f.adminRpcCall).not.toHaveBeenCalled();
  });

  it.each([
    ["platform_server", "command"],
    ["platform_server", "tool"],
    ["assigned_vm", "command"],
    ["assigned_vm", "tool"],
  ] as const)(
    "installs the current publication through %s %s service flow",
    async (target, entrypoint) => {
      const f = await fixture();
      const entry = f.entry!;
      f.nativeVersions.set(`${entry.namespace}/${entry.slug}`, new Set(["1.0.0"]));
      await f.service.publish(f.actor, {
        operationId: randomUUID(),
        id: entry.id,
        expectedRevision: entry.revision,
        skill: entry.slug,
        version: "1.0.1",
        source: "platform_server",
      });
      if (target === "assigned_vm") {
        await f.activateVm((await f.saveVm()).id);
      }
      f.adapterMocks.download.mockImplementation(async (_namespace, _slug, version) =>
        archive(version),
      );
      if (entrypoint === "command") {
        expect(
          await f.service.knoxCommand(
            f.actor.user.accountId,
            `install ${entry.id}`,
            "en",
            context(f.actor.agentId),
          ),
        ).toEqual({ text: "Installed: demo-skill@1.0.1" });
      } else {
        const expectedVersion = "1.0.1";
        const recommended = await f.service.knoxTool(
          f.actor.user.accountId,
          "search",
          {},
          context(f.actor.agentId),
        );
        expect(recommended).toMatchObject({
          items: [{ id: entry.id, latestVersion: expectedVersion }],
        });
        expect(
          await f.service.knoxTool(
            f.actor.user.accountId,
            "install",
            { id: entry.id, version: expectedVersion },
            context(f.actor.agentId),
          ),
        ).toMatchObject({ ok: true, noOp: false, version: "1.0.1", target });
      }
      expect((await f.service.workspaceSkills(f.actor, target)).items[0]).toMatchObject({
        hubSkillId: entry.id,
        hubVersion: "1.0.1",
        version: "1.0.1",
      });
    },
  );

  it("imports a recorded legacy coordinate outside the publisher inventory using newest-ID history", async () => {
    class LegacyStore extends SqliteControlPlaneStore {
      seedLegacy(ownerUserId: string) {
        ensureSkillHubStateSchema(this.db);
        this.db
          .prepare(
            "INSERT INTO skill_hub_skill_ownership (namespace, slug, owner_user_id, visibility, current_version, updated_at) VALUES ('global', 'legacy-skill', ?, 'PRIVATE', '1.0.0', 6)",
          )
          .run(ownerUserId);
      }
    }
    const f = await fixture([], undefined, { registrySkill: "absent" });
    const store = new LegacyStore({
      databasePath: path.join(f.workspaceRoot, "legacy.sqlite"),
      initialAdminAccountIds: ["legacy.admin"],
      buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
    });
    const { user } = await store.upsertPrincipal(
      {
        provider: "ldap",
        subject: "legacy.owner",
        accountId: "legacy.owner",
        employeeId: "legacy.owner",
        groups: [],
      },
      1,
    );
    const { binding } = await store.reservePersonalAgent(user.id, 1);
    await store.transitionAgent({ bindingId: binding.id, state: "active", changedAt: 2 });
    await store.createBrowserSession({
      userId: user.id,
      tokenHash: hashBrowserSessionToken("legacy-token"),
      createdAt: 3,
    });
    store.seedLegacy(user.id);
    f.native.set("global/legacy-skill", {
      id: 99,
      namespace: "global",
      slug: "legacy-skill",
      displayName: "Legacy",
      summary: "Legacy",
      visibility: "PRIVATE",
      status: "PUBLISHED",
    });
    f.nativeVersions.set("global/legacy-skill", new Set(["1.0.0", "10.0.0", "2.0.0"]));
    const service = new SkillHubService({
      store,
      workspaceRoot: f.workspaceRoot,
      maxPackageBytes: 1024 * 1024,
      buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
      organization: new OrganizationService(store),
      adminRpc: {
        call: async () => {
          throw new Error("Migration must not invoke Gateway");
        },
      },
      governance: { ...f.governanceMocks, listOwnedSkills: async () => ({ items: [], total: 0 }) },
      authService: new BrowserAuthService({
        store,
        now: () => 100,
        authenticator: {
          authenticatePassword: async () => ({ status: "rejected", message: "Unused" }),
        },
        provisioner: { provisionOrRefresh: async () => undefined },
      }),
    });
    try {
      expect(await service.authenticate("legacy-token")).not.toBeNull();
      expect(await store.skillHubCatalog.getByCoordinate("global", "legacy-skill")).toMatchObject({
        currentVersion: "2.0.0",
        ownerUserId: user.id,
        sharing: { mode: "PUBLIC" },
      });
      expect(await store.skillHubCatalog.migrationComplete()).toBe(true);
    } finally {
      service.close();
      store.close();
    }
  });
});
