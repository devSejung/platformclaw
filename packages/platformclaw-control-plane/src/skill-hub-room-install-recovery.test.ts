import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import { computeSkillPromptVersion } from "../../../src/skills/loading/skill-version.js";
import { SKILL_HUB_UPLOAD_ENTRIES } from "./skill-hub-service-support.js";
import { createSkillHubServiceFixture } from "./skill-hub-service.test-fixtures.js";

const manifest = "---\nname: demo-skill\ndescription: Demo\nversion: 1.0.0\n---\nInstructions\n";
const revision = computeSkillPromptVersion(manifest);
const migration = "legacy-room-installations-v1";

async function setup(personal = false, archivePaths: readonly string[] = []) {
  // The legacy workspace and record exist before authentication starts the worker.
  const f = await createSkillHubServiceFixture([], undefined, { authenticate: false });
  const room = await f.store.reserveKnoxRoomAgent({
    accountId: "fixture",
    roomId: "recovery-room",
    reservedAt: 5,
  });
  await f.store.transitionAgent({ bindingId: room.binding.id, state: "active", changedAt: 6 });
  const actor = personal
    ? f.actor
    : {
        ...f.actor,
        agentId: room.binding.agentId,
        workspaceDir: path.join(f.workspaceRoot, room.binding.agentId),
        roomBinding: room.binding,
      };
  const zip = new JSZip();
  zip.file("SKILL.md", manifest);
  zip.file("helper.txt", "expected");
  zip.folder("empty");
  for (const entry of archivePaths) {
    zip.file(entry, "", { createFolders: false });
  }
  const archive = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  f.adapterMocks.download.mockResolvedValue(archive);
  const entry = f.entry!;
  return {
    ...f,
    actor,
    archive,
    entry,
    archiveSha256: createHash("sha256").update(archive).digest("hex"),
    skillDir: path.join(actor.workspaceDir, "skills", entry.slug),
  };
}

describe("Knox room Skill Hub installation recovery", () => {
  it.each([
    "match",
    "implicit-directories",
    "extra-directory",
    "changed-file",
    "missing",
    "digest-mismatch",
    "blocked",
    "private",
    "personal",
  ] as const)("reconciles only the verified legacy room installation (%s)", async (scenario) => {
    const archivePaths =
      scenario === "implicit-directories"
        ? Array.from({ length: Math.floor(SKILL_HUB_UPLOAD_ENTRIES / 2) }, (_, index) =>
            path.posix.join(`parent-${index}`, "data.txt"),
          )
        : [];
    const f = await setup(scenario === "personal", archivePaths);
    const catalog = f.store.skillHubCatalog;
    const filePath = path.join(f.skillDir, "SKILL.md");
    if (scenario !== "missing") {
      await mkdir(f.skillDir, { recursive: true });
      await mkdir(path.join(f.skillDir, "empty"));
      await writeFile(filePath, manifest);
      await writeFile(
        path.join(f.skillDir, "helper.txt"),
        scenario === "changed-file" ? "tampered" : "expected",
      );
      for (const entry of archivePaths) {
        const filename = path.join(f.skillDir, entry);
        await mkdir(path.dirname(filename), { recursive: true });
        await writeFile(filename, "");
      }
      if (scenario === "extra-directory") {
        await mkdir(path.join(f.skillDir, "unrecorded"));
      }
    }
    if (scenario === "blocked") {
      await catalog.blockVersion({
        skillId: f.entry.id,
        version: "1.0.0",
        reason: "test",
        now: 12,
      });
    }
    if (scenario === "private") {
      await f.service.updateMetadata(f.actor.user, f.entry.id, {
        expectedRevision: f.entry.revision,
        sharing: { mode: "PRIVATE", userIds: [], scopeIds: [] },
      });
    }
    const origin = await catalog.recordInstallation({
      operationId: "legacy-test-installation",
      agentId: f.actor.agentId,
      destination: "platform_server",
      targetId: "platform-server",
      slug: f.entry.slug,
      skillId: f.entry.id,
      version: "1.0.0",
      archiveSha256: scenario === "digest-mismatch" ? "1".repeat(64) : f.archiveSha256,
      installedAt: 13,
    });
    const candidates = [{ name: f.entry.slug, filePath }];
    expect((await f.service.roomSkills(f.actor.agentId, candidates)).excludedPaths).toEqual(
      scenario === "personal" ? [] : [filePath],
    );
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(await catalog.migrationComplete(migration)).toBe(false);
      await f.service.processGovernanceQueue();
      await vi.waitFor(async () => expect(await catalog.migrationComplete(migration)).toBe(true), {
        timeout: scenario === "implicit-directories" ? 30_000 : 1_000,
      });
      const recovered = scenario === "match" || scenario === "implicit-directories";
      expect(await catalog.listInstallations(f.actor.agentId, "platform-server")).toEqual([
        {
          ...origin,
          state: recovered ? "completed" : "pending",
          installedRevision: recovered ? revision : null,
        },
      ]);
      expect((await f.service.roomSkills(f.actor.agentId, candidates)).excludedPaths).toEqual(
        recovered || scenario === "personal" ? [] : [filePath],
      );
      if (!recovered && scenario !== "personal") {
        expect(warning).toHaveBeenCalledWith(
          "[PlatformClaw Skill Hub] Legacy room skill remains excluded",
          expect.objectContaining({
            agentId: f.actor.agentId,
            slug: f.entry.slug,
            reason: expect.any(String),
          }),
        );
      }
      const downloads = f.adapterMocks.download.mock.calls.length;
      await f.service.processGovernanceQueue();
      expect(f.adapterMocks.download).toHaveBeenCalledTimes(downloads);
    } finally {
      warning.mockRestore();
    }
  });

  it.each(["match", "wrong digest"] as const)(
    "completes from the room install receipt (%s)",
    async (digest) => {
      const f = await setup();
      f.adminRpcCall.mockImplementation(async (method, params) => {
        if (method === "skills.status") {
          // Pending records can be absent from discovery even after the writer commits.
          return { skills: [] };
        }
        if (method === "skills.install" && digest === "wrong digest") {
          return { ok: true, slug: params.slug, sha256: "0".repeat(64) };
        }
        return await f.gatewayCall(method, params);
      });
      const install = f.service.install(f.actor, {
        id: f.entry.id,
        version: "1.0.0",
        destination: "platform_server",
      });
      if (digest === "match") {
        await expect(install).resolves.toMatchObject({ ok: true });
      } else {
        await expect(install).rejects.toThrow("Gateway returned an invalid install result");
      }
      expect(
        f.adminRpcCall.mock.calls.filter(([method]) => method === "skills.status"),
      ).toHaveLength(1);
      expect(
        await f.store.skillHubCatalog.listInstallations(f.actor.agentId, "platform-server"),
      ).toEqual([
        expect.objectContaining({
          state: digest === "match" ? "completed" : "pending",
          installedRevision: digest === "match" ? revision : null,
        }),
      ]);
    },
  );
});
