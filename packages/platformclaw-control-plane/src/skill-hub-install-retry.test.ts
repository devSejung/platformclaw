import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { createSkillHubServiceFixture as fixture } from "./skill-hub-service.test-fixtures.js";

async function skillArchive(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "SKILL.md",
    "---\nname: demo-skill\ndescription: Demo\nversion: 1.0.0\n---\nInstructions",
  );
  return await zip.generateAsync({ type: "nodebuffer", platform: "UNIX", compression: "DEFLATE" });
}

describe("SkillHubService install retry", () => {
  it("resumes a partially received upload from the Gateway-owned offset", async () => {
    const { service, actor, adapterMocks, adminRpcCall } = await fixture();
    const archive = await skillArchive();
    const receivedBytes = Math.floor(archive.byteLength / 2);
    adapterMocks.download.mockResolvedValue(archive);
    adminRpcCall.mockImplementation(async (method) => {
      if (method === "skills.upload.begin") {
        return { uploadId: "upload-partial", receivedBytes };
      }
      if (method === "skills.install") {
        return { ok: true, slug: "demo-skill" };
      }
      return { ok: true };
    });

    await expect(
      service.install(actor, {
        namespace: "engineering",
        slug: "demo-skill",
        version: "1.0.0",
        destination: "platform_server",
      }),
    ).resolves.toMatchObject({ ok: true, noOp: false });
    expect(adminRpcCall).toHaveBeenCalledWith("skills.upload.chunk", {
      uploadId: "upload-partial",
      offset: receivedBytes,
      dataBase64: archive.subarray(receivedBytes).toString("base64"),
    });
  });

  it("reuses an already committed upload without sending another chunk", async () => {
    const { service, actor, adapterMocks, adminRpcCall } = await fixture();
    const archive = await skillArchive();
    adapterMocks.download.mockResolvedValue(archive);
    adminRpcCall.mockImplementation(async (method) => {
      if (method === "skills.upload.begin") {
        return { uploadId: "upload-committed", receivedBytes: archive.byteLength };
      }
      if (method === "skills.install") {
        return { ok: true, slug: "demo-skill" };
      }
      return { ok: true };
    });

    await expect(
      service.install(actor, {
        namespace: "engineering",
        slug: "demo-skill",
        version: "1.0.0",
        destination: "platform_server",
      }),
    ).resolves.toMatchObject({ ok: true, noOp: false });
    expect(adminRpcCall.mock.calls.map(([method]) => method)).toEqual([
      "skills.status",
      "skills.upload.begin",
      "skills.upload.commit",
      "skills.install",
    ]);
  });

  it("isolates concurrent upload retries by Agent and destination", async () => {
    const {
      service,
      actor,
      adapterMocks,
      adminRpcCall,
      getPersonalExecutionProfile,
      getVmAllocationForAgent,
    } = await fixture();
    const archive = await skillArchive();
    adapterMocks.download.mockResolvedValue(archive);
    getPersonalExecutionProfile.mockResolvedValue({
      agentBindingId: "binding-1",
      activeTarget: "assigned_vm",
      activeAllocationId: "allocation-1",
      targetRevision: 3,
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
    const beginKeys: string[] = [];
    adminRpcCall.mockImplementation(async (method, params) => {
      if (method === "skills.upload.begin") {
        const key = (params as { idempotencyKey: string }).idempotencyKey;
        beginKeys.push(key);
        return { uploadId: `upload-${beginKeys.length}`, receivedBytes: 0 };
      }
      if (method === "skills.install") {
        return { ok: true, slug: "demo-skill" };
      }
      return { skills: [] };
    });

    await Promise.all([
      service.install(actor, {
        namespace: "engineering",
        slug: "demo-skill",
        version: "1.0.0",
        destination: "platform_server",
      }),
      service.install(actor, {
        namespace: "engineering",
        slug: "demo-skill",
        version: "1.0.0",
        destination: "assigned_vm",
      }),
      service.install(
        { ...actor, agentId: "agent-2" },
        {
          namespace: "engineering",
          slug: "demo-skill",
          version: "1.0.0",
          destination: "platform_server",
        },
      ),
    ]);
    expect(new Set(beginKeys).size).toBe(3);
    expect(beginKeys).toEqual(
      expect.arrayContaining([
        expect.stringContaining('["skill-hub","agent-1","platform_server","install"'),
        expect.stringContaining('["skill-hub","agent-1","assigned_vm","install"'),
        expect.stringContaining('["skill-hub","agent-2","platform_server","install"'),
      ]),
    );
  });

  it("serializes duplicate installs for the same Agent destination", async () => {
    const { service, actor, adapterMocks, adminRpcCall } = await fixture();
    adapterMocks.download.mockResolvedValue(await skillArchive());
    let installed = false;
    let releaseInstall!: () => void;
    const installGate = new Promise<void>((resolve) => {
      releaseInstall = resolve;
    });
    let installStarted!: () => void;
    const installStartedGate = new Promise<void>((resolve) => {
      installStarted = resolve;
    });
    adminRpcCall.mockImplementation(async (method) => {
      if (method === "skills.status") {
        return installed
          ? {
              skills: [
                {
                  skillKey: "demo-skill",
                  source: "openclaw-workspace",
                  version: "1.0.0",
                },
              ],
            }
          : { skills: [] };
      }
      if (method === "skills.upload.begin") {
        return { uploadId: "upload-serialized", receivedBytes: 0 };
      }
      if (method === "skills.install") {
        installStarted();
        await installGate;
        installed = true;
        return { ok: true, slug: "demo-skill" };
      }
      return { ok: true };
    });
    const params = {
      namespace: "engineering",
      slug: "demo-skill",
      version: "1.0.0",
      destination: "platform_server" as const,
    };

    const first = service.install(actor, params);
    await installStartedGate;
    const second = service.install(actor, params);
    await Promise.resolve();
    expect(adminRpcCall.mock.calls.filter(([method]) => method === "skills.status")).toHaveLength(
      1,
    );
    releaseInstall();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ noOp: false }),
      expect.objectContaining({ noOp: true }),
    ]);
    expect(
      adminRpcCall.mock.calls.filter(([method]) => method === "skills.upload.begin"),
    ).toHaveLength(1);
    expect(adminRpcCall.mock.calls.filter(([method]) => method === "skills.install")).toHaveLength(
      1,
    );
  });
});
