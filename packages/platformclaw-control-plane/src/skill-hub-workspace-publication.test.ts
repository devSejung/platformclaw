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
  it("publishes an assigned-VM skill through revision-pinned bounded Gateway chunks", async () => {
    const {
      service,
      actor,
      adapterMocks,
      adminRpcCall,
      getPersonalExecutionProfile,
      getVmAllocationForAgent,
      recordAuditEvent,
    } = await fixture();
    getPersonalExecutionProfile.mockResolvedValue({
      agentBindingId: "binding-1",
      activeTarget: "assigned_vm",
      activeAllocationId: "allocation-1",
      targetRevision: 8,
      updatedAt: 1,
    });
    getVmAllocationForAgent.mockResolvedValue({
      id: "allocation-1",
      agentBindingId: "binding-1",
      vmHostId: "host-1",
      linuxAccount: "person-one",
      status: "ready",
      remoteHomeDir: "/home/person-one",
      remoteWorkspaceDir: "/home/person-one/workspace",
      createdByUserId: "admin-1",
      createdAt: 1,
      updatedAt: 1,
    });
    const bytes = await archive("1.2.3");
    adminRpcCall.mockImplementation(async (method, request) => {
      if (method === "platformclaw-execution.skillExport.begin") {
        return { exportId: "export-one", token: "export-secret" };
      }
      if (method === "platformclaw-execution.skillExport.status") {
        return { state: "ready", size: bytes.length };
      }
      if (method === "platformclaw-execution.skillExport.read") {
        return { offset: request.offset, data: bytes.toString("base64"), done: true };
      }
      return { ok: true };
    });
    await expect(
      service.publish(actor, {
        skill: "demo-skill",
        source: "assigned_vm",
        namespace: "engineering",
        version: "1.2.3",
        visibility: "NAMESPACE_ONLY",
      }),
    ).resolves.toMatchObject({ slug: "demo-skill", version: "1.2.3" });
    expect(adminRpcCall).toHaveBeenCalledWith(
      "platformclaw-execution.skillExport.begin",
      expect.objectContaining({
        agentId: "agent-1",
        expectedTargetRevision: 8,
        expectedAllocationId: "allocation-1",
      }),
    );
    expect(adminRpcCall).toHaveBeenLastCalledWith(
      "platformclaw-execution.skillExport.close",
      expect.objectContaining({ agentId: "agent-1", exportId: "export-one" }),
    );
    expect(adapterMocks.publish).toHaveBeenCalledWith(
      expect.objectContaining({ archive: expect.objectContaining({ size: bytes.length }) }),
    );
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "skill-hub.publish",
        details: expect.objectContaining({ source: "assigned_vm" }),
      }),
    );
  });

  it("publishes explicit Basic source without switching an active VM target", async () => {
    const { service, actor, getPersonalExecutionProfile, adminRpcCall } = await fixture();
    getPersonalExecutionProfile.mockResolvedValue({
      agentBindingId: "binding-1",
      activeTarget: "assigned_vm",
      activeAllocationId: "allocation-1",
      targetRevision: 8,
      updatedAt: 1,
    });
    await expect(
      service.publish(actor, {
        skill: "demo-skill",
        source: "platform_server",
        namespace: "engineering",
        version: "1.2.3",
        visibility: "NAMESPACE_ONLY",
      }),
    ).resolves.toMatchObject({ slug: "demo-skill" });
    expect(adminRpcCall).not.toHaveBeenCalled();
  });

  it("rejects unavailable VM publication without Basic workspace fallback", async () => {
    const { service, actor, adapterMocks } = await fixture();
    await expect(
      service.publish(actor, {
        skill: "demo-skill",
        source: "assigned_vm",
        namespace: "engineering",
        version: "1.2.3",
        visibility: "NAMESPACE_ONLY",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(adapterMocks.publish).not.toHaveBeenCalled();
  });

  it("publishes the active workspace skill from a Knox slash command", async () => {
    const { service, adminRpcCall, adapterMocks } = await fixture();
    adminRpcCall.mockResolvedValue({
      skills: [{ skillKey: "demo-skill", source: "openclaw-workspace", version: "1.2.3" }],
    });
    await expect(service.command("person.one", "publish demo-skill")).resolves.toMatchObject({
      text: expect.stringContaining("## Published"),
    });
    expect(adapterMocks.publish).toHaveBeenCalledOnce();
  });

  it("lists only owner workspace skills for the explicitly selected source", async () => {
    const { service, actor, adminRpcCall } = await fixture();
    adminRpcCall.mockResolvedValue({
      skills: [
        { skillKey: "demo-skill", source: "openclaw-workspace", version: "1.2.3", path: "/secret" },
        { skillKey: "bundled", source: "openclaw-bundled" },
      ],
    });
    await expect(service.workspaceSkills(actor, "platform_server")).resolves.toEqual({
      source: "platform_server",
      items: [{ skillKey: "demo-skill", version: "1.2.3" }],
    });
  });
});
