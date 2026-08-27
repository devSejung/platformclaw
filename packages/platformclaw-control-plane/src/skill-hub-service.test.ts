import { link, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import { validateDownloadedArchive } from "./skill-hub-service-support.js";
import { SkillHubServiceError } from "./skill-hub-service.js";
import {
  createSkillHubServiceFixture as fixture,
  skillHubTestUser as user,
} from "./skill-hub-service.test-fixtures.js";

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
  it("serves English help by default and Korean help only when requested", async () => {
    const { service } = await fixture();

    await expect(service.command("person.one", "help")).resolves.toMatchObject({
      text: expect.stringContaining("## SkillHub commands"),
    });
    await expect(service.command("person.one", "help ko")).resolves.toMatchObject({
      text: expect.stringContaining("## SkillHub 명령어"),
    });
    await expect(service.command("person.one", "help en")).resolves.toMatchObject({
      text: expect.not.stringContaining("명령어"),
    });
  });

  it("allows effective scope reads but requires direct membership or leadership to publish", async () => {
    const { service, actor, adapterMocks, authorizeManagedScope } = await fixture();
    adapterMocks.getSkill.mockResolvedValue({
      id: 10,
      namespace: "engineering",
      slug: "demo-skill",
      displayName: "Demo Skill",
      summary: "Demo",
      visibility: "NAMESPACE_ONLY",
      status: "PUBLISHED",
    });
    authorizeManagedScope.mockResolvedValue({
      canRead: true,
      canManageMembers: false,
      canManageStructure: false,
      canManageLeaders: false,
      facts: { source: "membership", scopeIds: ["descendant-part"] },
    });

    await expect(service.detail(actor.user, "engineering", "demo-skill")).resolves.toMatchObject({
      skill: { slug: "demo-skill" },
    });
    await expect(
      service.publish(actor, {
        skill: "demo-skill",
        namespace: "engineering",
        version: "1.2.3",
        visibility: "NAMESPACE_ONLY",
      }),
    ).rejects.toMatchObject({ statusCode: 403 });

    authorizeManagedScope.mockResolvedValue({
      canRead: true,
      canManageMembers: true,
      canManageStructure: false,
      canManageLeaders: false,
      facts: { source: "leadership", scopeIds: ["ancestor-team"] },
    });
    await expect(
      service.publish(actor, {
        skill: "demo-skill",
        namespace: "engineering",
        version: "1.2.3",
        visibility: "NAMESPACE_ONLY",
      }),
    ).resolves.toMatchObject({ namespace: "engineering", slug: "demo-skill" });
  });

  it("withholds ownership revision from readers who cannot manage the skill", async () => {
    const { service, actor, adapterMocks, store } = await fixture();
    adapterMocks.getSkill.mockResolvedValue({
      id: 10,
      namespace: "engineering",
      slug: "demo-skill",
      displayName: "Demo Skill",
      summary: "Demo",
      visibility: "NAMESPACE_ONLY",
      status: "PUBLISHED",
    });
    await store.recordSkillHubPublication({
      namespace: "engineering",
      slug: "demo-skill",
      ownerUserId: actor.user.id,
      expectedOwnerUserId: null,
      expectedOwnerUpdatedAt: null,
      expectedBindingUpdatedAt: 1,
      visibility: "NAMESPACE_ONLY",
      version: "1.0.0",
      changedAt: 10,
    });
    const detail = await service.detail(
      { ...actor.user, id: "reader-user", accountId: "reader.user" },
      "engineering",
      "demo-skill",
    );
    expect(detail.owner).toEqual({ assigned: true, isMine: false, unassigned: false });
    expect(JSON.stringify(detail.owner)).not.toMatch(/revision|userId|accountId/iu);
  });

  it("surfaces post-registry ownership reconciliation and queues governance without an owner", async () => {
    const { service, actor, store } = await fixture(["engineering"], {
      approvePendingReview: vi.fn(async () => ({ reviewId: 1, status: "APPROVED" })),
    });
    vi.spyOn(store, "recordSkillHubPublication").mockResolvedValue({
      namespace: "engineering",
      slug: "demo-skill",
      ownerUserId: null,
      previousOwnerUserId: actor.user.id,
      visibility: "PRIVATE",
      currentVersion: "1.2.3",
      updatedAt: 100,
      reconciliationRequired: true,
    });
    const enqueue = vi.spyOn(store, "enqueueSkillHubGovernanceJob");
    await expect(
      service.publish(actor, {
        skill: "demo-skill",
        namespace: "engineering",
        version: "1.2.3",
        visibility: "PUBLIC",
      }),
    ).resolves.toMatchObject({ ownershipReviewRequired: true });
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ ownerUserId: null }));
  });

  it("keeps Global restricted until activation and reserves Global publish for admins", async () => {
    const { service, actor, adapterMocks, getSkillHubNamespaceBinding, authorizeManagedScope } =
      await fixture();
    adapterMocks.getSkill.mockResolvedValue({
      id: 10,
      namespace: "engineering",
      slug: "demo-skill",
      displayName: "Demo Skill",
      summary: "Demo",
      visibility: "NAMESPACE_ONLY",
      status: "PUBLISHED",
    });
    const binding = {
      namespace: "engineering",
      scopeKind: "global" as const,
      accessState: "restricted" as const,
      visibilityCeiling: "PUBLIC" as const,
      createdByUserId: "admin-1",
      createdAt: 1,
      updatedAt: 1,
    };
    getSkillHubNamespaceBinding.mockResolvedValue(binding);
    await expect(service.detail(actor.user, "engineering", "demo-skill")).rejects.toMatchObject({
      statusCode: 404,
    });

    getSkillHubNamespaceBinding.mockResolvedValue({ ...binding, accessState: "active" });
    await expect(service.detail(actor.user, "engineering", "demo-skill")).resolves.toMatchObject({
      skill: { slug: "demo-skill" },
    });
    await expect(
      service.publish(actor, {
        skill: "demo-skill",
        namespace: "engineering",
        version: "1.2.3",
        visibility: "NAMESPACE_ONLY",
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(authorizeManagedScope).not.toHaveBeenCalled();
  });

  it("projects management mutations without internal audit and ownership fields", async () => {
    const { service, actor } = await fixture();
    await service.publish(actor, {
      skill: "demo-skill",
      namespace: "engineering",
      version: "1.2.3",
      visibility: "PRIVATE",
    });

    const grant = await service.setAccess(actor.user, "engineering", "demo-skill", {
      userId: "recipient-1",
      inheritVersions: true,
    });
    expect(grant).toEqual({
      userId: "recipient-1",
      expiresAt: null,
      inheritVersions: true,
      grantedVersion: null,
      canReshare: false,
    });
    expect(JSON.stringify(grant)).not.toMatch(/grantedByUserId|createdAt|updatedAt/u);

    const transfer = await service.transferOwner(
      actor.user,
      "engineering",
      "demo-skill",
      "owner-2",
      1,
    );
    expect(transfer).toEqual({ ownerUserId: "owner-2" });
    expect(JSON.stringify(transfer)).not.toMatch(/previousOwnerUserId|currentVersion|updatedAt/u);

    const admin = { ...actor.user, globalRole: "admin" as const };
    const binding = await service.setNamespaceBinding(admin, {
      namespace: "engineering",
      scopeKind: "team",
      scopeId: "scope-1",
      visibilityCeiling: "NAMESPACE_ONLY",
      expectedUpdatedAt: null,
      reason: "organization rollout",
    });
    expect(JSON.stringify(binding)).not.toContain("createdByUserId");
  });

  it("lists every accessible catalog item through paged Knox output", async () => {
    const { service, adapterMocks } = await fixture();
    adapterMocks.search.mockResolvedValue({
      items: [
        {
          namespace: "engineering",
          slug: "demo-skill",
          summary: "Demo",
          visibility: "PUBLIC",
          latestVersion: "1.2.3",
        },
      ],
      total: 1,
    });

    await expect(service.command("person.one", "list")).resolves.toMatchObject({
      text: expect.stringContaining("`demo-skill` | `engineering` | `1.2.3`"),
    });
  });

  it("requires confirmation and revision-pins SkillHub deletion", async () => {
    const { service, adapterMocks, adminRpcCall } = await fixture();
    adapterMocks.search.mockResolvedValue({
      items: [
        {
          namespace: "engineering",
          slug: "demo-skill",
          summary: "Demo",
          visibility: "PUBLIC",
          latestVersion: "1.2.3",
        },
      ],
      total: 1,
    });
    adminRpcCall.mockImplementation(async (method: string) =>
      method === "skills.status"
        ? {
            skills: [
              {
                skillKey: "demo-skill",
                source: "openclaw-workspace",
                version: "1.2.3",
                revision: "sha256:0123456789abcdef",
              },
            ],
          }
        : { ok: true, slug: "demo-skill" },
    );

    await expect(service.command("person.one", "delete demo-skill")).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(
      service.command("person.one", "delete demo-skill --confirm"),
    ).resolves.toMatchObject({ text: expect.stringContaining("## Deleted") });
    expect(adminRpcCall).toHaveBeenCalledWith(
      "skills.uninstall",
      expect.objectContaining({
        slug: "demo-skill",
        expectedSkillRevision: "sha256:0123456789abcdef",
        backendTarget: "platform_server",
      }),
    );
  });

  it("packages the real workspace skill and overrides only the published version", async () => {
    const { service, actor, adapterMocks, skillDir, recordAuditEvent } = await fixture();
    await writeFile(path.join(skillDir, ".env"), "TOKEN=must-not-publish");
    await writeFile(path.join(skillDir, "client.pem"), "must-not-publish");
    await mkdir(path.join(skillDir, ".openclaw"));
    await writeFile(path.join(skillDir, ".openclaw", "state.json"), "must-not-publish");
    await mkdir(path.join(skillDir, "references"));
    await writeFile(path.join(skillDir, "references", "guide.md"), "guide");

    await expect(
      service.publish(actor, {
        skill: "demo-skill",
        namespace: "engineering",
        version: "1.2.3",
        visibility: "NAMESPACE_ONLY",
      }),
    ).resolves.toMatchObject({ slug: "demo-skill", version: "1.2.3" });

    const publish = adapterMocks.publish;
    const archive = publish.mock.calls[0]?.[0].archive;
    const zip = await JSZip.loadAsync(archive!);
    expect(await zip.file("SKILL.md")!.async("string")).toContain("version: 1.2.3");
    expect(await zip.file("helper.txt")!.async("string")).toBe("hello");
    expect(await zip.file("references/guide.md")!.async("string")).toBe("guide");
    expect(zip.files["references/"]).toBeUndefined();
    expect(zip.file(".env")).toBeNull();
    expect(zip.file("client.pem")).toBeNull();
    expect(zip.file(".openclaw/state.json")).toBeNull();
    expect(await readFile(path.join(skillDir, "SKILL.md"), "utf8")).toContain("version: 0.0.1");
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "skill-hub.publish", actorUserId: user.id }),
    );
  });

  it("rejects a configured namespace when the member lacks organization publish access", async () => {
    const { service, actor, adapterMocks, authorizeManagedScope } = await fixture([]);
    authorizeManagedScope.mockResolvedValue({
      canRead: false,
      canManageMembers: false,
      canManageStructure: false,
      canManageLeaders: false,
      facts: { source: "none", scopeIds: [] },
    });
    await expect(
      service.publish(actor, {
        skill: "demo-skill",
        namespace: "engineering",
        version: "1.0.0",
        visibility: "PUBLIC",
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(adapterMocks.publish).not.toHaveBeenCalled();
  });

  it("rejects a workspace symbolic link instead of packaging its target", async () => {
    const { service, actor, skillDir } = await fixture();
    const outside = path.join(path.dirname(path.dirname(skillDir)), "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.txt"), "secret");
    await symlink(outside, path.join(skillDir, "leak"), "junction");

    await expect(
      service.publish(actor, {
        skill: "demo-skill",
        namespace: "engineering",
        version: "1.0.0",
        visibility: "PRIVATE",
      }),
    ).rejects.toThrow("symbolic link");
  });

  it.runIf(process.platform !== "win32")(
    "rejects a workspace hardlink instead of publishing aliased content",
    async () => {
      const { service, actor, skillDir } = await fixture();
      const outside = path.join(path.dirname(path.dirname(skillDir)), "outside-secret.txt");
      await writeFile(outside, "secret");
      await link(outside, path.join(skillDir, "aliased-secret.txt"));

      await expect(
        service.publish(actor, {
          skill: "demo-skill",
          namespace: "engineering",
          version: "1.0.0",
          visibility: "PRIVATE",
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
    const { service, actor, adapterMocks, adminRpcCall } = await fixture();
    adapterMocks.download.mockResolvedValue(await makeArchive());

    await expect(
      service.install(actor, {
        namespace: "engineering",
        slug: "demo-skill",
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
    const { service, actor, adapterMocks, adminRpcCall } = await fixture();
    adapterMocks.download.mockResolvedValue(await skillArchive());
    adminRpcCall.mockImplementation(async (method) => {
      if (method === "skills.upload.begin") {
        return { uploadId: "upload-1", receivedBytes: 0 };
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
    ]);
    expect(adminRpcCall).toHaveBeenCalledWith(
      "skills.upload.begin",
      expect.objectContaining({
        idempotencyKey: expect.stringContaining(
          '["skill-hub","agent-1","platform_server","install"',
        ),
      }),
    );
    expect(adminRpcCall).toHaveBeenLastCalledWith(
      "skills.install",
      expect.objectContaining({
        agentId: "agent-1",
        source: "upload",
        force: false,
        destination: "sandbox-backend",
        expectedTargetRevision: 0,
      }),
    );
  });

  it("requires explicit replacement when the installed slug has the exact version", async () => {
    const { service, actor, adapterMocks, adminRpcCall } = await fixture();
    adminRpcCall.mockResolvedValue({
      skills: [
        {
          skillKey: "demo-skill",
          source: "openclaw-workspace",
          version: "1.0.0",
          revision: "sha256:0123456789abcdef",
        },
      ],
    });

    await expect(
      service.install(actor, {
        namespace: "engineering",
        slug: "demo-skill",
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
    const { service, actor, adapterMocks, adminRpcCall } = await fixture();
    adapterMocks.download.mockResolvedValue(await skillArchive({ version: "2.0.0" }));
    adminRpcCall.mockImplementation(async (method) => {
      if (method === "skills.status") {
        return {
          skills: [
            {
              skillKey: "demo-skill",
              source: "openclaw-workspace",
              version: "1.0.0",
              revision: "sha256:0123456789abcdef",
            },
          ],
        };
      }
      if (method === "skills.upload.begin") {
        return { uploadId: "upload-update", receivedBytes: 0 };
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
        namespace: "engineering",
        slug: "demo-skill",
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
          '["skill-hub","agent-1","platform_server","update"',
        ),
      }),
    );
    expect(adminRpcCall).toHaveBeenLastCalledWith(
      "skills.install",
      expect.objectContaining({
        force: true,
        backendTarget: "platform_server",
        expectedSkillRevision: "sha256:0123456789abcdef",
      }),
    );
  });

  it("pins an assigned VM target without exposing the Gateway destination", async () => {
    const {
      service,
      actor,
      adapterMocks,
      adminRpcCall,
      getPersonalExecutionProfile,
      getVmAllocationForAgent,
    } = await fixture();
    getPersonalExecutionProfile.mockResolvedValue({
      agentBindingId: "binding-1",
      activeTarget: "assigned_vm",
      activeAllocationId: "allocation-1",
      targetRevision: 7,
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
    adapterMocks.download.mockResolvedValue(await skillArchive());
    adminRpcCall.mockImplementation(async (method) => {
      if (method === "skills.upload.begin") {
        return { uploadId: "upload-1", receivedBytes: 0 };
      }
      if (method === "skills.install") {
        return { ok: true, slug: "demo-skill", targetDir: "/private/vm/path" };
      }
      return { ok: true };
    });

    await expect(
      service.install(actor, {
        namespace: "engineering",
        slug: "demo-skill",
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
    expect(adminRpcCall).toHaveBeenLastCalledWith(
      "skills.install",
      expect.objectContaining({
        destination: "sandbox-backend",
        expectedTargetRevision: 7,
      }),
    );
  });

  it("allows an explicit Basic destination while My VM is active", async () => {
    const { service, actor, adapterMocks, adminRpcCall, getPersonalExecutionProfile } =
      await fixture();
    getPersonalExecutionProfile.mockResolvedValue({
      agentBindingId: "binding-1",
      activeTarget: "assigned_vm",
      activeAllocationId: "allocation-1",
      targetRevision: 8,
      updatedAt: 1,
    });
    adapterMocks.download.mockResolvedValue(await skillArchive());
    adminRpcCall.mockImplementation(async (method) => {
      if (method === "skills.upload.begin") {
        return { uploadId: "upload-1", receivedBytes: 0 };
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
    ).resolves.toMatchObject({ target: "platform_server" });
    expect(adminRpcCall).toHaveBeenLastCalledWith(
      "skills.install",
      expect.objectContaining({ backendTarget: "platform_server", expectedTargetRevision: 8 }),
    );
  });

  it("rejects an archive whose SKILL.md declares a different requested version", async () => {
    const { service, actor, adapterMocks, adminRpcCall } = await fixture();
    adapterMocks.download.mockResolvedValue(await skillArchive({ version: "9.9.9" }));

    await expect(
      service.install(actor, {
        namespace: "engineering",
        slug: "demo-skill",
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
    const { service, actor, adapterMocks, recordAuditEvent } = await fixture();
    adapterMocks.publish.mockResolvedValue({
      namespace: "engineering",
      slug: "other-skill",
      version: "1.2.3",
      visibility: "PUBLIC",
    });

    await expect(
      service.publish(actor, {
        skill: "demo-skill",
        namespace: "engineering",
        version: "1.2.3",
        visibility: "PUBLIC",
      }),
    ).rejects.toMatchObject({ statusCode: 502 });
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });

  it("filters and conceals restricted skills outside the bound organization scope", async () => {
    const { service, actor, adapterMocks, adminRpcCall, authorizeManagedScope, store } =
      await fixture([]);
    authorizeManagedScope.mockResolvedValue({
      canRead: false,
      canManageMembers: false,
      canManageStructure: false,
      canManageLeaders: false,
      facts: { source: "none", scopeIds: [] },
    });
    adapterMocks.search.mockResolvedValue({
      items: [
        {
          namespace: "engineering",
          slug: "demo-skill",
          latestVersion: "1.0.0",
          summary: "Demo",
          visibility: "PRIVATE",
        },
      ],
      total: 1,
    });
    adapterMocks.getSkill.mockResolvedValue({
      id: 10,
      namespace: "engineering",
      slug: "demo-skill",
      displayName: "Demo Skill",
      summary: "Demo",
      visibility: "PRIVATE",
      status: "PUBLISHED",
    });
    await store.recordSkillHubPublication({
      namespace: "engineering",
      slug: "demo-skill",
      ownerUserId: "other-owner",
      expectedOwnerUserId: null,
      expectedOwnerUpdatedAt: null,
      expectedBindingUpdatedAt: 1,
      visibility: "PUBLIC",
      version: "1.0.0",
      changedAt: 1,
    });

    await expect(service.search(actor.user, "demo")).resolves.toEqual({ items: [], total: 0 });
    await expect(service.detail(actor.user, "engineering", "demo-skill")).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(
      service.install(actor, {
        namespace: "engineering",
        slug: "demo-skill",
        version: "1.0.0",
        destination: "platform_server",
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(adapterMocks.download).not.toHaveBeenCalled();
    expect(adminRpcCall).not.toHaveBeenCalled();
  });

  it("enforces a lowered namespace visibility ceiling on existing registry content", async () => {
    const { service, actor, adapterMocks, adminRpcCall, getSkillHubNamespaceBinding } =
      await fixture();
    getSkillHubNamespaceBinding.mockResolvedValue({
      namespace: "engineering",
      scopeKind: "team",
      scopeId: "scope-1",
      accessState: "active",
      visibilityCeiling: "PRIVATE",
      createdByUserId: "admin-1",
      createdAt: 1,
      updatedAt: 2,
    });
    adapterMocks.search.mockResolvedValue({
      items: [
        {
          namespace: "engineering",
          slug: "demo-skill",
          latestVersion: "1.0.0",
          summary: "Demo",
          visibility: "PUBLIC",
        },
      ],
      total: 1,
    });
    adapterMocks.getSkill.mockResolvedValue({
      id: 10,
      namespace: "engineering",
      slug: "demo-skill",
      displayName: "Demo Skill",
      summary: "Demo",
      visibility: "PUBLIC",
      status: "PUBLISHED",
    });
    await expect(service.search(actor.user, "demo")).resolves.toEqual({ items: [], total: 0 });
    await expect(service.detail(actor.user, "engineering", "demo-skill")).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(
      service.install(actor, {
        namespace: "engineering",
        slug: "demo-skill",
        version: "1.0.0",
        destination: "platform_server",
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(adapterMocks.download).not.toHaveBeenCalled();
    expect(adminRpcCall).not.toHaveBeenCalled();
  });

  it("recovers a persisted clean-scan job and auto-approves its exact review", async () => {
    const approvePendingReview = vi.fn(async () => ({ reviewId: 42, status: "APPROVED" }));
    const { service, adapterMocks, store } = await fixture(["engineering"], {
      approvePendingReview,
    });
    vi.spyOn(store, "listDueSkillHubGovernanceJobs").mockResolvedValue([
      {
        namespace: "engineering",
        slug: "demo-skill",
        version: "1.0.0",
        ownerUserId: user.id,
        state: "pending",
        attempts: 1,
        nextAttemptAt: 1,
        updatedAt: 1,
      },
    ]);
    vi.spyOn(store, "getSkillHubOwnership").mockResolvedValue({
      namespace: "engineering",
      slug: "demo-skill",
      ownerUserId: user.id,
      visibility: "PUBLIC",
      currentVersion: "1.0.0",
      updatedAt: 1,
    });
    adapterMocks.listVersions.mockResolvedValue([
      {
        id: 20,
        version: "1.0.0",
        status: "PENDING_REVIEW",
        downloadAvailable: true,
      },
    ]);
    adapterMocks.listSecurityAudits.mockResolvedValue([
      { scannerType: "skill-scanner", verdict: "CLEAN", isSafe: true },
    ]);
    const updateJob = vi.spyOn(store, "updateSkillHubGovernanceJob");

    await expect(service.processGovernanceQueue()).resolves.toEqual({ processed: 1 });
    expect(approvePendingReview).toHaveBeenCalledWith({
      namespace: "engineering",
      slug: "demo-skill",
      version: "1.0.0",
      comment: "PlatformClaw automatic approval after a clean security scan.",
    });
    expect(updateJob).toHaveBeenCalledWith(
      expect.objectContaining({ state: "approved", attempts: 2 }),
    );
  });

  it("never auto-approves a reconciliation job without a current owner", async () => {
    const approvePendingReview = vi.fn(async () => ({ reviewId: 42, status: "APPROVED" }));
    const { service, store } = await fixture(["engineering"], { approvePendingReview });
    vi.spyOn(store, "listDueSkillHubGovernanceJobs").mockResolvedValue([
      {
        namespace: "engineering",
        slug: "demo-skill",
        version: "1.0.0",
        ownerUserId: null,
        state: "pending",
        attempts: 0,
        nextAttemptAt: 1,
        updatedAt: 1,
      },
    ]);
    const update = vi.spyOn(store, "updateSkillHubGovernanceJob");
    await expect(service.processGovernanceQueue()).resolves.toEqual({ processed: 1 });
    expect(approvePendingReview).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ state: "blocked", lastError: "owner-review-required" }),
    );
  });

  it("reports ownership review when force approval commits during an ownership change", async () => {
    const approvePendingReview = vi.fn(async () => ({ reviewId: 42, status: "APPROVED" }));
    const { service, actor, store } = await fixture(["engineering"], { approvePendingReview });
    const current = {
      namespace: "engineering",
      slug: "demo-skill",
      ownerUserId: actor.user.id,
      visibility: "PRIVATE" as const,
      currentVersion: "1.0.0",
      updatedAt: 1,
    };
    vi.spyOn(store, "getSkillHubOwnership")
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(null);
    await expect(
      service.acknowledgeForcePublish(actor.user, "engineering", "demo-skill", {
        version: "1.0.0",
        acknowledged: true,
        reason: "reviewed scanner exception",
      }),
    ).resolves.toMatchObject({
      upstreamOverridePerformed: true,
      ownershipReviewRequired: true,
    });
    expect(approvePendingReview).toHaveBeenCalledTimes(1);
  });

  it("projects the administrator unassigned-owner queue without internal owner fields", async () => {
    const { service, actor, store } = await fixture();
    vi.spyOn(store, "listUnassignedSkillHubSkills").mockResolvedValue([
      {
        namespace: "engineering",
        slug: "demo-skill",
        ownerUserId: null,
        previousOwnerUserId: "former-owner",
        visibility: "NAMESPACE_ONLY",
        currentVersion: "1.2.3",
        updatedAt: 99,
      },
    ]);

    await expect(service.unassignedSkills({ ...actor.user, globalRole: "admin" })).resolves.toEqual(
      {
        items: [
          {
            namespace: "engineering",
            slug: "demo-skill",
            currentVersion: "1.2.3",
            visibility: "NAMESPACE_ONLY",
            changedAt: 99,
          },
        ],
      },
    );
  });
});
