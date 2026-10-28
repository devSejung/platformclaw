import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { SkillHubAdapterError } from "./skill-hub-adapter.js";
import { SkillHubServiceBase } from "./skill-hub-service-base.js";
import { createSkillHubServiceFixture as fixture } from "./skill-hub-service.test-fixtures.js";

class BasicArchiveService extends SkillHubServiceBase {
  protected async processGovernanceQueue() {
    return { processed: 0 };
  }
  package(workspaceDir: string, slug: string, version: string) {
    return this.packageWorkspaceSkill(workspaceDir, slug, version);
  }
}

async function archiveFixture(maxPackageBytes = 1024 * 1024) {
  const f = await fixture([], undefined, { registrySkill: "absent" });
  const service = new BasicArchiveService({
    authService: f.authService,
    store: f.store,
    adminRpc: {
      call: async () => {
        throw new Error("Packaging must not call Gateway");
      },
    },
    workspaceRoot: f.workspaceRoot,
    organization: f.organization,
    maxPackageBytes,
    buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
  });
  return { ...f, archiveService: service };
}

describe("Basic workspace streamed archive", () => {
  it("writes deterministic owner-only ZIP files while preserving workspace bytes", async () => {
    const f = await archiveFixture();
    const original = await readFile(path.join(f.skillDir, "SKILL.md"));
    const first = await f.archiveService.package(f.actor.workspaceDir, "demo-skill", "1.2.3");
    const second = await f.archiveService.package(f.actor.workspaceDir, "demo-skill", "1.2.3");
    try {
      const bytes = await readFile(first.path);
      expect(first).toMatchObject({ summary: "Demo skill", size: bytes.byteLength });
      expect(first.path).not.toBe(second.path);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(
        createHash("sha256")
          .update(await readFile(second.path))
          .digest("hex"),
      );
      const zip = await JSZip.loadAsync(bytes);
      expect(await zip.file("SKILL.md")!.async("string")).toContain("version: 1.2.3");
      expect(await zip.file("helper.txt")!.async("string")).toBe("hello");
      expect(await readFile(path.join(f.skillDir, "SKILL.md"))).toEqual(original);
      if (process.platform !== "win32") {
        expect((await lstat(first.path)).mode & 0o777).toBe(0o600);
        expect((await lstat(path.dirname(first.path))).mode & 0o777).toBe(0o700);
      }
    } finally {
      await Promise.all([first.cleanup(), second.cleanup()]);
    }
    await expect(lstat(first.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(second.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stops at the compressed byte ceiling and removes the incomplete temporary export", async () => {
    const f = await archiveFixture(1024);
    const slug = `bounded-${randomUUID()}`;
    const skillDir = path.join(f.actor.workspaceDir, "skills", slug);
    await mkdir(skillDir);
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      `---\nname: ${slug}\ndescription: Bounded ZIP proof\nversion: 1.0.0\n---\nInstructions`,
    );
    await writeFile(path.join(skillDir, "payload.bin"), randomBytes(16 * 1024));
    await expect(
      f.archiveService.package(f.actor.workspaceDir, slug, "1.0.0"),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: "workspace skill ZIP exceeds the configured package limit",
    });
    expect(
      (await readdir(tmpdir())).filter((name) =>
        name.startsWith(`platformclaw-skill-hub-${slug}-`),
      ),
    ).toEqual([]);
    expect(f.governanceMocks.publishArtifact).not.toHaveBeenCalled();
    expect(await f.store.skillHubCatalog.listPendingPublications()).toEqual([]);
  });

  it("rejects oversized streamed SKILL.md without leaving a temporary export", async () => {
    const f = await archiveFixture();
    const slug = `markdown-${randomUUID()}`;
    const skillDir = path.join(f.actor.workspaceDir, "skills", slug);
    await mkdir(skillDir);
    await writeFile(path.join(skillDir, "SKILL.md"), Buffer.alloc(256 * 1024 + 1, "x"));
    await expect(
      f.archiveService.package(f.actor.workspaceDir, slug, "1.0.0"),
    ).rejects.toMatchObject({ statusCode: 400, message: "SKILL.md exceeds the size limit" });
    expect(
      (await readdir(tmpdir())).filter((name) =>
        name.startsWith(`platformclaw-skill-hub-${slug}-`),
      ),
    ).toEqual([]);
  });

  it("removes a completed temporary ZIP when the registry publication fails", async () => {
    const f = await archiveFixture();
    let archivePath: string | undefined;
    f.governanceMocks.publishArtifact.mockImplementation(async (params) => {
      if (Buffer.isBuffer(params.archive)) {
        throw new Error("Basic publication must stream a temporary artifact");
      }
      archivePath = params.archive.path;
      expect((await lstat(archivePath)).size).toBe(params.archive.size);
      throw new SkillHubAdapterError("Synthetic registry unavailable", 503);
    });
    await expect(
      f.service.publish(f.actor, {
        operationId: randomUUID(),
        skill: "demo-skill",
        source: "platform_server",
        version: "1.2.3",
      }),
    ).rejects.toMatchObject({ statusCode: 502 });
    if (!archivePath) {
      throw new Error("Registry publication was not reached");
    }
    await expect(lstat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(f.skillDir, "SKILL.md"), "utf8")).toContain("version: 0.0.1");
  });
});
