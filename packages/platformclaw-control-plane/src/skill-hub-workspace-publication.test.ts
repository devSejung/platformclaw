import { randomUUID } from "node:crypto";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { createSkillHubServiceFixture as fixture } from "./skill-hub-service.test-fixtures.js";

async function archive(version: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "SKILL.md",
    `---\nname: demo-skill\ndescription: Demo\nversion: ${version}\n---\nInstructions`,
  );
  return await zip.generateAsync({ type: "nodebuffer", platform: "UNIX", compression: "DEFLATE" });
}

describe("Skill Hub workspace publication", () => {
  it.each([false, true])(
    "revalidates assigned-VM publication after export (revoked=%s)",
    async (revoked) => {
      const { service, store, actor, governanceMocks, adminRpcCall, saveVm, activateVm } =
        await fixture(undefined, undefined, { registrySkill: "absent" });
      const target = await activateVm((await saveVm()).id);
      const bytes = await archive("1.2.3");
      adminRpcCall.mockImplementation(async (method, request) => {
        if (method === "platformclaw-execution.skillExport.begin") {
          return { exportId: "export-one", token: "export-secret" };
        }
        if (method === "platformclaw-execution.skillExport.status") {
          return { state: "ready", size: bytes.length };
        }
        if (method === "platformclaw-execution.skillExport.read") {
          if (revoked) {
            const binding = await store.getPersonalAgentBinding(actor.user.id);
            if (!binding) {
              throw new Error("Missing fixture binding");
            }
            await store.transitionAgent({
              bindingId: binding.id,
              state: "disabled",
              changedAt: 50,
            });
          }
          return { offset: request.offset, data: bytes.toString("base64"), done: true };
        }
        return { ok: true };
      });
      const publication = service.publish(actor, {
        operationId: randomUUID(),
        skill: "demo-skill",
        source: "assigned_vm",
        version: "1.2.3",
      });
      if (revoked) {
        await expect(publication).rejects.toMatchObject({ statusCode: 409 });
        expect(governanceMocks.publishArtifact).not.toHaveBeenCalled();
        return;
      }
      await expect(publication).resolves.toMatchObject({ slug: "demo-skill", version: "1.2.3" });
      expect(adminRpcCall).toHaveBeenCalledWith(
        "platformclaw-execution.skillExport.begin",
        expect.objectContaining({
          agentId: actor.agentId,
          expectedTargetRevision: target.revision,
          expectedAllocationId: target.allocationId,
        }),
      );
      expect(adminRpcCall).toHaveBeenLastCalledWith(
        "platformclaw-execution.skillExport.close",
        expect.objectContaining({ agentId: actor.agentId, exportId: "export-one" }),
      );
      expect(governanceMocks.publishArtifact).toHaveBeenCalledWith(
        expect.objectContaining({ archive: expect.objectContaining({ size: bytes.length }) }),
      );
      const entry = (await store.skillHubCatalog.list())[0]!;
      expect(entry.sharing.mode).toBe("PUBLIC");
      expect(
        await store.skillHubCatalog.listHistory({ skillId: entry.id, actorUserId: actor.user.id }),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ action: "version-published", actorUserId: actor.user.id }),
        ]),
      );
    },
  );

  it("publishes explicit Basic source without switching an active VM target", async () => {
    const { service, actor, getPersonalExecutionProfile, adminRpcCall } = await fixture(
      undefined,
      undefined,
      { registrySkill: "absent" },
    );
    getPersonalExecutionProfile.mockResolvedValue({
      agentBindingId: "binding-1",
      activeTarget: "assigned_vm",
      activeAllocationId: "allocation-1",
      targetRevision: 8,
      updatedAt: 1,
    });
    await expect(
      service.publish(actor, {
        operationId: randomUUID(),
        skill: "demo-skill",
        source: "platform_server",
        version: "1.2.3",
      }),
    ).resolves.toMatchObject({ slug: "demo-skill" });
    expect(adminRpcCall).not.toHaveBeenCalled();
  });

  it("rejects unavailable VM publication without Basic workspace fallback", async () => {
    const { service, actor, governanceMocks } = await fixture(undefined, undefined, {
      registrySkill: "absent",
    });
    await expect(
      service.publish(actor, {
        operationId: randomUUID(),
        skill: "demo-skill",
        source: "assigned_vm",
        version: "1.2.3",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(governanceMocks.publishArtifact).not.toHaveBeenCalled();
  });

  it("lists only owner workspace skills for the explicitly selected source", async () => {
    const { service, actor, adminRpcCall } = await fixture(undefined, undefined, {
      registrySkill: "absent",
    });
    adminRpcCall.mockResolvedValue({
      skills: [
        {
          skillKey: "metadata-alias",
          source: "openclaw-workspace",
          baseDir: "/workspace/skills/demo-skill",
          version: "1.2.3",
          path: "/secret",
        },
        { skillKey: "bundled", source: "openclaw-bundled" },
      ],
    });
    await expect(service.workspaceSkills(actor, "platform_server")).resolves.toEqual({
      source: "platform_server",
      targetId: "platform-server",
      targetRevision: 0,
      items: [{ skillKey: "demo-skill", version: "1.2.3" }],
    });
  });
});
