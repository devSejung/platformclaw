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
    const { service, actor, entry, adapterMocks, adminRpcCall, gatewayCall, uploads, store } =
      await fixture();
    const archive = await skillArchive();
    const receivedBytes = Math.floor(archive.byteLength / 2);
    uploads.set("upload-partial", archive.subarray(0, receivedBytes));
    adapterMocks.download.mockResolvedValue(archive);
    adminRpcCall.mockImplementation(async (method, params) =>
      method === "skills.upload.begin"
        ? { uploadId: "upload-partial", receivedBytes }
        : await gatewayCall(method, params),
    );
    await expect(
      service.install(actor, { id: entry!.id, version: "1.0.0", destination: "platform_server" }),
    ).resolves.toMatchObject({ ok: true, noOp: false });
    expect(adminRpcCall).toHaveBeenCalledWith("skills.upload.chunk", {
      uploadId: "upload-partial",
      offset: receivedBytes,
      dataBase64: archive.subarray(receivedBytes).toString("base64"),
    });
    expect(await store.skillHubCatalog.listInstallations(actor.agentId, "platform-server")).toEqual(
      [
        expect.objectContaining({
          skillId: entry!.id,
          operationId: "upload-partial",
          state: "completed",
          installedRevision: expect.stringMatching(/^sha256:/u),
        }),
      ],
    );
  });

  it("reuses an already committed upload without sending another chunk", async () => {
    const { service, actor, entry, adapterMocks, adminRpcCall, gatewayCall, uploads } =
      await fixture();
    const archive = await skillArchive();
    uploads.set("upload-committed", archive);
    adapterMocks.download.mockResolvedValue(archive);
    adminRpcCall.mockImplementation(async (method, params) =>
      method === "skills.upload.begin"
        ? { uploadId: "upload-committed", receivedBytes: archive.byteLength }
        : await gatewayCall(method, params),
    );
    await expect(
      service.install(actor, { id: entry!.id, version: "1.0.0", destination: "platform_server" }),
    ).resolves.toMatchObject({ ok: true, noOp: false });
    expect(adminRpcCall.mock.calls.map(([method]) => method)).toEqual([
      "skills.status",
      "skills.upload.begin",
      "skills.upload.commit",
      "skills.install",
      "skills.status",
    ]);
  });

  it("isolates concurrent upload retries by real Agent binding and destination", async () => {
    const {
      service,
      actor,
      entry,
      createActor,
      adapterMocks,
      adminRpcCall,
      gatewayCall,
      saveVm,
      activateVm,
      store,
    } = await fixture();
    const other = await createActor("person.two");
    const vm = await activateVm((await saveVm()).id);
    adapterMocks.download.mockResolvedValue(await skillArchive());
    const beginKeys: string[] = [];
    adminRpcCall.mockImplementation(async (method, params) => {
      if (method === "skills.upload.begin") {
        beginKeys.push(String(params.idempotencyKey));
      }
      return await gatewayCall(method, params);
    });
    await Promise.all([
      service.install(actor, { id: entry!.id, version: "1.0.0", destination: "platform_server" }),
      service.install(actor, { id: entry!.id, version: "1.0.0", destination: "assigned_vm" }),
      service.install(other, { id: entry!.id, version: "1.0.0", destination: "platform_server" }),
    ]);
    expect(new Set(beginKeys).size).toBe(3);
    expect(beginKeys.map((key) => JSON.parse(key).slice(0, 4))).toEqual(
      expect.arrayContaining([
        ["skill-hub", actor.agentId, "platform_server", "install"],
        ["skill-hub", actor.agentId, "assigned_vm", "install"],
        ["skill-hub", other.agentId, "platform_server", "install"],
      ]),
    );
    expect(
      await store.skillHubCatalog.listInstallations(actor.agentId, "platform-server"),
    ).toHaveLength(1);
    expect(await store.skillHubCatalog.listInstallations(actor.agentId, vm.targetId)).toHaveLength(
      1,
    );
    expect(
      await store.skillHubCatalog.listInstallations(other.agentId, "platform-server"),
    ).toHaveLength(1);
  });

  it("coalesces duplicate installs for the same Agent destination", async () => {
    const { service, actor, entry, adapterMocks, adminRpcCall, gatewayCall } = await fixture();
    adapterMocks.download.mockResolvedValue(await skillArchive());
    let releaseInstall!: () => void;
    const installGate = new Promise<void>((resolve) => {
      releaseInstall = resolve;
    });
    let installStarted!: () => void;
    const installStartedGate = new Promise<void>((resolve) => {
      installStarted = resolve;
    });
    adminRpcCall.mockImplementation(async (method, params) => {
      if (method === "skills.install") {
        installStarted();
        await installGate;
      }
      return await gatewayCall(method, params);
    });
    const params = { id: entry!.id, version: "1.0.0", destination: "platform_server" as const };
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
      expect.objectContaining({ noOp: false }),
    ]);
    expect(
      adminRpcCall.mock.calls.filter(([method]) => method === "skills.upload.begin"),
    ).toHaveLength(1);
    expect(adminRpcCall.mock.calls.filter(([method]) => method === "skills.install")).toHaveLength(
      1,
    );
  });
});
