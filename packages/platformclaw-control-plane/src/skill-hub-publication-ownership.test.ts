import { writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { SkillHubAdapterError } from "./skill-hub-adapter.js";
import { createSkillHubServiceFixture as fixture } from "./skill-hub-service.test-fixtures.js";

describe("first Skill Hub publication ownership", () => {
  it.each(["platform_server", "assigned_vm", "upload"] as const)(
    "does not adopt an existing untracked registry skill through %s",
    async (source) => {
      const { service, actor, adapterMocks, adminRpcCall, store, workspaceRoot } = await fixture();
      const fields = { namespace: "engineering", version: "1.2.3", visibility: "NAMESPACE_ONLY" };
      let publication: Promise<unknown>;
      if (source === "upload") {
        const zip = new JSZip();
        zip.file(
          "SKILL.md",
          "---\nname: demo-skill\ndescription: Demo\nversion: 1.2.3\n---\nInstructions",
        );
        const archive = await zip.generateAsync({ type: "nodebuffer" });
        const archivePath = path.join(workspaceRoot, "upload.zip");
        await writeFile(archivePath, archive);
        publication = service.publishArchive(
          actor,
          { ...fields, slug: "demo-skill" },
          { path: archivePath, size: archive.byteLength },
        );
      } else {
        publication = service.publish(actor, { ...fields, skill: "demo-skill", source });
      }
      await expect(publication).rejects.toMatchObject({
        statusCode: 403,
        details: { code: "skill-hub-untracked-skill" },
      });
      expect(adapterMocks.publish).not.toHaveBeenCalled();
      expect(adminRpcCall).not.toHaveBeenCalled();
      await expect(store.getSkillHubOwnership("engineering", "demo-skill")).resolves.toBeNull();
    },
  );

  it.each([400, 403, 503])(
    "does not treat registry failure %s as an absent skill",
    async (statusCode) => {
      const { service, actor, adapterMocks } = await fixture();
      adapterMocks.getSkill.mockRejectedValue(
        new SkillHubAdapterError("request rejected", statusCode),
      );
      await expect(
        service.publish(actor, {
          skill: "demo-skill",
          namespace: "engineering",
          version: "1.2.3",
          visibility: "NAMESPACE_ONLY",
        }),
      ).rejects.toMatchObject({ statusCode: statusCode === 403 ? 403 : 502 });
      expect(adapterMocks.publish).not.toHaveBeenCalled();
    },
  );

  it("lets an administrator explicitly publish an existing untracked registry skill", async () => {
    const { service, actor, adapterMocks, store } = await fixture();
    const administrator = { ...actor, user: { ...actor.user, globalRole: "admin" as const } };
    await expect(
      service.publish(administrator, {
        skill: "demo-skill",
        namespace: "engineering",
        version: "1.2.3",
        visibility: "NAMESPACE_ONLY",
      }),
    ).resolves.toMatchObject({ slug: "demo-skill" });
    expect(adapterMocks.publish).toHaveBeenCalledOnce();
    await expect(store.getSkillHubOwnership("engineering", "demo-skill")).resolves.toMatchObject({
      ownerUserId: actor.user.id,
    });
  });
});
