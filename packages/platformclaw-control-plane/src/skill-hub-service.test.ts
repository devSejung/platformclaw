import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { validateDownloadedArchive } from "./skill-hub-service-support.js";
import { SkillHubServiceError } from "./skill-hub-service.js";
import { createSkillHubServiceFixture as fixture } from "./skill-hub-service.test-fixtures.js";

async function skillArchive(
  params: {
    name?: string;
    version?: string;
    extra?: (zip: JSZip) => void;
    body?: string;
  } = {},
): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "SKILL.md",
    `---\nname: ${params.name ?? "demo-skill"}\ndescription: Demo\nversion: ${params.version ?? "1.0.0"}\n---\n${params.body ?? "Instructions"}`,
  );
  params.extra?.(zip);
  return await zip.generateAsync({ type: "nodebuffer", platform: "UNIX", compression: "DEFLATE" });
}

function overwriteCentralUncompressedSize(
  archive: Buffer,
  filename: string,
  declaredSize: number,
): Buffer {
  const patched = Buffer.from(archive);
  for (let offset = 0; offset <= patched.byteLength - 46; offset += 1) {
    if (patched.readUInt32LE(offset) !== 0x02014b50) {
      continue;
    }
    const nameLength = patched.readUInt16LE(offset + 28);
    if (patched.subarray(offset + 46, offset + 46 + nameLength).toString("utf8") === filename) {
      patched.writeUInt32LE(declaredSize, offset + 24);
      return patched;
    }
  }
  throw new Error(`ZIP central directory entry not found: ${filename}`);
}

describe("SkillHubService", () => {
  it("packages the real workspace skill and overrides only the published version", async () => {
    const { service, actor, governanceMocks, skillDir, store } = await fixture(
      undefined,
      undefined,
      {
        registrySkill: "absent",
      },
    );
    await writeFile(path.join(skillDir, ".env"), "RUNTIME_MODE=production");
    await writeFile(path.join(skillDir, "client.pem"), "must-not-publish");
    await mkdir(path.join(skillDir, ".openclaw"));
    await writeFile(path.join(skillDir, ".openclaw", "state.json"), "must-not-publish");
    await mkdir(path.join(skillDir, "references"));
    await writeFile(path.join(skillDir, "references", "guide.md"), "guide");

    let archiveBytes: Buffer | undefined;
    const publish = governanceMocks.publishArtifact;
    const nativePublish = publish.getMockImplementation();
    if (!nativePublish) {
      throw new Error("Native fixture publisher missing");
    }
    publish.mockImplementation(async (params) => {
      archiveBytes = Buffer.isBuffer(params.archive)
        ? params.archive
        : await readFile(params.archive.path);
      return await nativePublish(params);
    });

    await expect(
      service.publish(actor, { operationId: randomUUID(), skill: "demo-skill", version: "1.2.3" }),
    ).resolves.toMatchObject({ slug: "demo-skill", version: "1.2.3" });

    if (!archiveBytes) {
      throw new Error("Published archive missing");
    }
    const zip = await JSZip.loadAsync(archiveBytes);
    expect(await zip.file("SKILL.md")!.async("string")).toContain("version: 1.2.3");
    expect(await zip.file("helper.txt")!.async("string")).toBe("hello");
    expect(await zip.file("references/guide.md")!.async("string")).toBe("guide");
    expect(zip.files["references/"]).toBeUndefined();
    expect(await zip.file(".env")!.async("string")).toBe("RUNTIME_MODE=production");
    expect(zip.file("client.pem")).toBeNull();
    expect(zip.file(".openclaw/state.json")).toBeNull();
    expect(await readFile(path.join(skillDir, "SKILL.md"), "utf8")).toContain("version: 0.0.1");
    const published = (await store.skillHubCatalog.list())[0]!;
    expect(
      await store.skillHubCatalog.listHistory({
        skillId: published.id,
        actorUserId: actor.user.id,
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "version-published", actorUserId: actor.user.id }),
      ]),
    );
  });

  it("rejects a workspace symbolic link instead of packaging its target", async () => {
    const { service, actor, skillDir } = await fixture(undefined, undefined, {
      registrySkill: "absent",
    });
    const outside = path.join(path.dirname(path.dirname(skillDir)), "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.txt"), "secret");
    await symlink(outside, path.join(skillDir, "leak"), "junction");

    await expect(
      service.publish(actor, { operationId: randomUUID(), skill: "demo-skill", version: "1.0.0" }),
    ).rejects.toThrow("symbolic link");
  });

  it.runIf(process.platform !== "win32")(
    "rejects a workspace hardlink instead of publishing aliased content",
    async () => {
      const { service, actor, skillDir } = await fixture(undefined, undefined, {
        registrySkill: "absent",
      });
      const outside = path.join(path.dirname(path.dirname(skillDir)), "outside-secret.txt");
      await writeFile(outside, "secret");
      await link(outside, path.join(skillDir, "aliased-secret.txt"));

      await expect(
        service.publish(actor, {
          operationId: randomUUID(),
          skill: "demo-skill",
          version: "1.0.0",
        }),
      ).rejects.toThrow("unsupported file");
    },
  );

  it.each([
    ["path traversal", () => skillArchive({ extra: (zip) => zip.file("../escape", "bad") })],
    [
      "symbolic link",
      () =>
        skillArchive({
          extra: (zip) => zip.file("link", "target", { unixPermissions: 0o120777 }),
        }),
    ],
    ["invalid SKILL.md", () => skillArchive({ name: "wrong-skill" })],
    [
      "reserved runtime metadata",
      () =>
        skillArchive({
          extra: (zip) => zip.file(".openclaw/source-origin.json", '{"slug":"other"}'),
        }),
    ],
  ])("blocks downloaded archives with %s", async (_label, makeArchive) => {
    const { service, actor, entry, adapterMocks, adminRpcCall } = await fixture();
    adapterMocks.download.mockResolvedValue(await makeArchive());

    await expect(
      service.install(actor, {
        id: entry!.id,
        version: "1.0.0",
        destination: "platform_server",
      }),
    ).rejects.toBeInstanceOf(SkillHubServiceError);
    expect(adminRpcCall).toHaveBeenCalledOnce();
    expect(adminRpcCall).toHaveBeenCalledWith(
      "skills.status",
      expect.objectContaining({ backendTarget: "platform_server", refresh: true }),
    );
  });

  it("streams to the package limit even when ZIP metadata understates extracted size", async () => {
    const archive = overwriteCentralUncompressedSize(
      await skillArchive({ extra: (zip) => zip.file("large.txt", "x".repeat(4096)) }),
      "large.txt",
      1,
    );

    await expect(
      validateDownloadedArchive(archive, "demo-skill", "1.0.0", {
        archiveBytes: 1024 * 1024,
        expandedBytes: 1024,
        entryBytes: 1024,
        files: 500,
        entries: 2_000,
      }),
    ).rejects.toThrow(/oversized entry|expands past/u);
  });

  it("uploads a validated exact version through the existing Gateway skill installer", async () => {
    const { service, actor, entry, adapterMocks, adminRpcCall } = await fixture();
    adapterMocks.download.mockResolvedValue(
      await skillArchive({ extra: (zip) => zip.file(".env", "RUNTIME_MODE=production") }),
    );

    await expect(
      service.install(actor, {
        id: entry!.id,
        version: "1.0.0",
        destination: "platform_server",
      }),
    ).resolves.toEqual({
      ok: true,
      noOp: false,
      slug: "demo-skill",
      version: "1.0.0",
      target: "platform_server",
    });
    expect(adminRpcCall.mock.calls.map(([method]) => method)).toEqual([
      "skills.status",
      "skills.upload.begin",
      "skills.upload.chunk",
      "skills.upload.commit",
      "skills.install",
      "skills.status",
    ]);
    expect(adminRpcCall).toHaveBeenCalledWith(
      "skills.upload.begin",
      expect.objectContaining({
        idempotencyKey: expect.stringContaining(
          JSON.stringify(["skill-hub", actor.agentId, "platform_server", "install"]).slice(0, -1),
        ),
      }),
    );
    expect(adminRpcCall).toHaveBeenCalledWith(
      "skills.install",
      expect.objectContaining({
        agentId: actor.agentId,
        source: "upload",
        force: false,
        destination: "sandbox-backend",
        expectedTargetRevision: 0,
      }),
    );
  });

  it("requires explicit replacement when the installed slug has the exact version", async () => {
    const { service, actor, entry, adapterMocks, adminRpcCall } = await fixture();
    adminRpcCall.mockResolvedValue({
      skills: [
        {
          skillKey: "demo-skill",
          source: "openclaw-workspace",
          baseDir: "/workspace/skills/demo-skill",
          version: "1.0.0",
          revision: "sha256:0123456789abcdef",
        },
      ],
    });

    await expect(
      service.install(actor, {
        id: entry!.id,
        version: "1.0.0",
        destination: "platform_server",
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      details: {
        code: "existing-skill-replacement-required",
        currentVersion: "1.0.0",
        currentRevision: "sha256:0123456789abcdef",
        requestedVersion: "1.0.0",
        direction: "reinstall",
      },
    });
    expect(adapterMocks.download).not.toHaveBeenCalled();
    expect(adminRpcCall).toHaveBeenCalledOnce();
  });

  it("requires an exact current-version acknowledgement before an atomic update", async () => {
    const { service, actor, entry, adapterMocks, adminRpcCall, gatewayCall } = await fixture();
    adapterMocks.download.mockResolvedValue(await skillArchive({ version: "2.0.0" }));
    let replaced = false;
    adminRpcCall.mockImplementation(async (method, params) => {
      if (method === "skills.status" && !replaced) {
        return {
          skills: [
            {
              skillKey: "demo-skill",
              source: "openclaw-workspace",
              baseDir: "/workspace/skills/demo-skill",
              version: "1.0.0",
              revision: "sha256:0123456789abcdef",
            },
          ],
        };
      }
      const response = await gatewayCall(method, params);
      if (method === "skills.install") {
        replaced = true;
      }
      return response;
    });

    await expect(
      service.install(actor, {
        id: entry!.id,
        version: "2.0.0",
        destination: "platform_server",
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      details: {
        code: "existing-skill-replacement-required",
        currentVersion: "1.0.0",
        currentRevision: "sha256:0123456789abcdef",
        requestedVersion: "2.0.0",
        direction: "upgrade",
      },
    });

    await expect(
      service.install(actor, {
        id: entry!.id,
        version: "2.0.0",
        destination: "platform_server",
        acknowledgedReplacement: true,
        currentRevision: "sha256:0123456789abcdef",
      }),
    ).resolves.toMatchObject({ ok: true, noOp: false, version: "2.0.0" });
    expect(adminRpcCall).toHaveBeenCalledWith(
      "skills.upload.begin",
      expect.objectContaining({
        idempotencyKey: expect.stringContaining(
          JSON.stringify(["skill-hub", actor.agentId, "platform_server", "update"]).slice(0, -1),
        ),
      }),
    );
    expect(adminRpcCall).toHaveBeenCalledWith(
      "skills.install",
      expect.objectContaining({
        force: true,
        backendTarget: "platform_server",
        expectedSkillRevision: "sha256:0123456789abcdef",
      }),
    );
  });

  it("pins an assigned VM target without exposing the Gateway destination", async () => {
    const { service, actor, entry, gatewayCall, adapterMocks, adminRpcCall, saveVm, activateVm } =
      await fixture();
    const target = await activateVm((await saveVm()).id);
    adapterMocks.download.mockResolvedValue(await skillArchive());
    adminRpcCall.mockImplementation(async (method, params) => {
      const result = await gatewayCall(method, params);
      return method === "skills.install"
        ? { ...(result as object), targetDir: "/private/vm/path" }
        : result;
    });

    await expect(
      service.install(actor, {
        id: entry!.id,
        version: "1.0.0",
        destination: "assigned_vm",
      }),
    ).resolves.toEqual({
      ok: true,
      noOp: false,
      slug: "demo-skill",
      version: "1.0.0",
      target: "assigned_vm",
    });
    expect(adminRpcCall).toHaveBeenCalledWith(
      "skills.install",
      expect.objectContaining({
        destination: "sandbox-backend",
        expectedTargetRevision: target.revision,
      }),
    );
  });

  it("allows an explicit Basic destination while My VM is active", async () => {
    const { service, actor, entry, adapterMocks, adminRpcCall, getPersonalExecutionProfile } =
      await fixture();
    getPersonalExecutionProfile.mockResolvedValue({
      agentBindingId: "binding-1",
      activeTarget: "assigned_vm",
      activeAllocationId: "allocation-1",
      targetRevision: 8,
      updatedAt: 1,
    });
    adapterMocks.download.mockResolvedValue(await skillArchive());

    await expect(
      service.install(actor, {
        id: entry!.id,
        version: "1.0.0",
        destination: "platform_server",
      }),
    ).resolves.toMatchObject({ target: "platform_server" });
    expect(adminRpcCall).toHaveBeenCalledWith(
      "skills.install",
      expect.objectContaining({ backendTarget: "platform_server", expectedTargetRevision: 8 }),
    );
  });

  it("rejects an archive whose SKILL.md declares a different requested version", async () => {
    const { service, actor, entry, adapterMocks, adminRpcCall } = await fixture();
    adapterMocks.download.mockResolvedValue(await skillArchive({ version: "9.9.9" }));

    await expect(
      service.install(actor, {
        id: entry!.id,
        version: "1.0.0",
        destination: "platform_server",
      }),
    ).rejects.toThrow("does not match");
    expect(adminRpcCall).toHaveBeenCalledOnce();
    expect(adminRpcCall).toHaveBeenCalledWith(
      "skills.status",
      expect.objectContaining({ backendTarget: "platform_server", refresh: true }),
    );
  });

  it("rejects a mismatched publish response before recording success", async () => {
    const { service, actor, governanceMocks, store } = await fixture(undefined, undefined, {
      registrySkill: "absent",
    });
    governanceMocks.publishArtifact.mockResolvedValue({
      skillId: 999,
      namespace: "wrong-native",
      slug: "other-skill",
      version: "1.2.3",
    });

    await expect(
      service.publish(actor, { operationId: randomUUID(), skill: "demo-skill", version: "1.2.3" }),
    ).rejects.toMatchObject({ statusCode: 502 });
    expect((await store.skillHubCatalog.list()).every((item) => item.currentVersion === null)).toBe(
      true,
    );
  });

  it("lets an ordinary member without an organization publish company-wide by default", async () => {
    const { service, actor, store, governanceMocks } = await fixture([], undefined, {
      registrySkill: "absent",
    });
    const published = await service.publish(actor, {
      operationId: randomUUID(),
      skill: "demo-skill",
      version: "1.2.3",
    });
    expect(actor.user.globalRole).toBe("member");
    expect(actor.user.groups).toEqual([]);
    expect(await store.skillHubCatalog.get(published.id)).toMatchObject({
      ownerUserId: actor.user.id,
      sharing: { mode: "PUBLIC" },
    });
    expect(governanceMocks.publishArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ filename: "demo-skill-1.2.3.zip" }),
    );
    expect(await service.config(actor)).toMatchObject({ defaultSharing: "PUBLIC", scopes: [] });
  });

  it("conceals private entries and keeps readers from changing a selected skill or reading management history", async () => {
    const { service, actor, createActor, seedEntry, store, adapterMocks } = await fixture(
      [],
      undefined,
      { registrySkill: "absent" },
    );
    const reader = await createActor("reader.user");
    const outsider = await createActor("outsider.user");
    const privateEntry = await seedEntry({
      sharing: { mode: "PRIVATE", userIds: [], scopeIds: [] },
    });
    await expect(service.detailById(reader.user, privateEntry.id)).rejects.toMatchObject({
      statusCode: 404,
    });
    const selected = await seedEntry({
      sharing: { mode: "SELECTED", userIds: [reader.user.id], scopeIds: [] },
    });
    await expect(service.detailById(reader.user, selected.id)).resolves.toMatchObject({
      canManage: false,
      owner: { user: { accountId: actor.user.accountId } },
    });
    expect(await service.search(outsider.user, "demo")).toEqual({ items: [], total: 0 });
    await expect(
      service.updateMetadata(reader.user, selected.id, {
        expectedRevision: selected.revision,
        summary: "Hijack",
      }),
    ).rejects.toThrow();
    await service.updateMetadata(actor.user, selected.id, {
      expectedRevision: selected.revision,
      tags: ["reviewed"],
    });
    const history = await service.history(reader.user, selected.id);
    expect(history.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ action: "version-published" })]),
    );
    expect(history.items.some((item) => item.action === "metadata-updated")).toBe(true);
    expect(
      history.items.some(
        (item) => item.action === "sharing-updated" || item.action.startsWith("administrator-"),
      ),
    ).toBe(false);
    await expect(
      service.install(outsider, {
        id: selected.id,
        version: "1.0.0",
        destination: "platform_server",
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(adapterMocks.download).not.toHaveBeenCalled();
    expect((await store.skillHubCatalog.get(selected.id))?.summary).toBe("Demo");
  });

  it("requires recipient acceptance to transfer editing rights and records both actors", async () => {
    const { service, actor, entry, createActor, store } = await fixture();
    const recipient = await createActor("next.owner");
    const request = await service.requestTransfer(
      actor.user,
      entry!.id,
      entry!.revision,
      recipient.user.id,
    );
    expect((await service.detailById(actor.user, entry!.id)).canManage).toBe(true);
    expect((await service.detailById(recipient.user, entry!.id)).canManage).toBe(false);
    await service.acceptTransfer(recipient.user, entry!.id, request.revision);
    expect((await service.detailById(actor.user, entry!.id)).canManage).toBe(false);
    expect((await service.detailById(recipient.user, entry!.id)).canManage).toBe(true);
    const history = await store.skillHubCatalog.listHistory({
      skillId: entry!.id,
      actorUserId: recipient.user.id,
    });
    expect(history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ actorUserId: actor.user.id }),
        expect.objectContaining({ actorUserId: recipient.user.id }),
      ]),
    );
  });
  it("rejects sharing on a new-version request and duplicate immutable versions before reservation", async () => {
    const { service, actor, entry, store, governanceMocks } = await fixture();
    await expect(
      service.publish(actor, {
        operationId: randomUUID(),
        skill: "demo-skill",
        version: "3.0.0",
        id: entry!.id,
        expectedRevision: entry!.revision,
        sharing: { mode: "PRIVATE", userIds: [], scopeIds: [] },
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      service.publish(actor, {
        operationId: randomUUID(),
        skill: "demo-skill",
        version: "1.0.0",
        id: entry!.id,
        expectedRevision: entry!.revision,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await store.skillHubCatalog.listPendingPublications()).toEqual([]);
    expect((await store.skillHubCatalog.get(entry!.id))?.revision).toBe(entry!.revision);
    expect(governanceMocks.publishArtifact).not.toHaveBeenCalled();
  });
});
