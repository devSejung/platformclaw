import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildWorkspaceSkillStatus } from "../../../src/skills/discovery/status.js";
import { removeWorkspaceSkill } from "../../../src/skills/lifecycle/archive-install.js";
import { createSkillHubServiceFixture as fixture } from "./skill-hub-service.test-fixtures.js";

function markdown(name: string, key: string, version?: string, body = "Instructions") {
  return `---\nname: ${name}\ndescription: Demo\nmetadata: {"openclaw":{"skillKey":"${key}"}}\n${version === undefined ? "" : `version: ${version}\n`}---\n${body}`;
}

describe("Skill Hub workspace package identity", () => {
  it("matches, confirms, and removes the physical package despite logical key collisions", async () => {
    const { service, actor, entry, skillDir, adminRpcCall, adapterMocks } = await fixture();
    const skillFile = path.join(skillDir, "SKILL.md");
    await writeFile(skillFile, markdown("demo-skill", "logical-alias", "1.0.0"));
    const siblingDir = path.join(actor.workspaceDir, "skills", "other-skill");
    await mkdir(siblingDir);
    await writeFile(
      path.join(siblingDir, "SKILL.md"),
      markdown("other-skill", "demo-skill", "9.0.0"),
    );
    const status = () =>
      buildWorkspaceSkillStatus(actor.workspaceDir, {
        managedSkillsDir: path.join(actor.workspaceDir, ".managed"),
      });
    expect(status().skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "demo-skill", skillKey: "logical-alias" }),
        expect.objectContaining({ name: "other-skill", skillKey: "demo-skill" }),
      ]),
    );
    adminRpcCall.mockImplementation(async (method, params) => {
      if (method === "skills.status") {
        return status();
      }
      if (method === "skills.uninstall") {
        return {
          ...(await removeWorkspaceSkill({
            workspaceDir: actor.workspaceDir,
            slug: String(params.slug),
            expectedSkillRevision: String(params.expectedSkillRevision),
          })),
          slug: params.slug,
        };
      }
      throw new Error(`unexpected RPC ${method}`);
    });
    const installed = await service.workspaceSkills(actor, "platform_server");
    expect(installed.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ skillKey: "demo-skill", version: "1.0.0" }),
        expect.objectContaining({ skillKey: "other-skill", version: "9.0.0" }),
      ]),
    );
    const currentRevision = installed.items.find(
      (item) => item.skillKey === "demo-skill",
    )!.revision;
    const request = {
      id: entry!.id,
      version: "2.0.0",
      destination: "platform_server" as const,
    };
    await expect(service.install(actor, request)).rejects.toMatchObject({
      statusCode: 409,
      details: {
        code: "existing-skill-replacement-required",
        currentVersion: "1.0.0",
        currentRevision,
      },
    });
    await writeFile(skillFile, markdown("demo-skill", "logical-alias", "1.0.0", "Changed"));
    const changedRevision = status().skills.find((item) => item.name === "demo-skill")!.revision;
    expect(changedRevision).not.toBe(currentRevision);
    await expect(
      service.install(actor, { ...request, acknowledgedReplacement: true, currentRevision }),
    ).rejects.toMatchObject({
      statusCode: 409,
      details: { currentRevision: changedRevision },
    });
    expect(adapterMocks.download).not.toHaveBeenCalled();
    await expect(service.uninstall(actor, "demo-skill")).resolves.toMatchObject({
      ok: true,
      slug: "demo-skill",
    });
    expect(adminRpcCall).toHaveBeenLastCalledWith(
      "skills.uninstall",
      expect.objectContaining({ slug: "demo-skill", expectedSkillRevision: changedRevision }),
    );
    await expect(readFile(skillFile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(siblingDir, "SKILL.md"), "utf8")).resolves.toContain("9.0.0");
  });

  it.each([undefined, "not-semver"])(
    "keeps an installed package with version %s visible and rejects replacement before download",
    async (version) => {
      const { service, actor, entry, skillDir, adminRpcCall, adapterMocks } = await fixture();
      await writeFile(path.join(skillDir, "SKILL.md"), markdown("demo-skill", "alias", version));
      adminRpcCall.mockImplementation(async (method) => {
        if (method !== "skills.status") {
          throw new Error(`unexpected RPC ${method}`);
        }
        return buildWorkspaceSkillStatus(actor.workspaceDir, {
          managedSkillsDir: path.join(actor.workspaceDir, ".managed"),
        });
      });
      const installed = await service.workspaceSkills(actor, "platform_server");
      expect(installed.items).toEqual([expect.objectContaining({ skillKey: "demo-skill" })]);
      expect(installed.items[0]).not.toHaveProperty("version");
      for (const acknowledgedReplacement of [false, true]) {
        await expect(
          service.install(actor, {
            id: entry!.id,
            version: "2.0.0",
            destination: "platform_server",
            acknowledgedReplacement,
            currentRevision: installed.items[0]!.revision,
          }),
        ).rejects.toMatchObject({
          statusCode: 409,
          details: { code: "installed-version-unavailable" },
        });
      }
      expect(adapterMocks.download).not.toHaveBeenCalled();
    },
  );
});
