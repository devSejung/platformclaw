import { link, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { BrowserAuthService } from "./browser-auth-service.js";
import type { ControlPlaneStore, PlatformUser } from "./contracts.js";
import type { ControlPlaneExecutionManagementStore } from "./execution-contracts.js";
import type { GatewayAdminRpc } from "./gateway-admin-rpc-client.js";
import type { SkillHubAdapter } from "./skill-hub-adapter.js";
import type { SkillHubGovernanceClient } from "./skill-hub-governance-client.js";
import type { SkillHubStore } from "./skill-hub-service-support.js";
import { SkillHubService, SkillHubServiceError } from "./skill-hub-service.js";
import type { SkillHubOwnership } from "./skill-hub-state.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const user: PlatformUser = {
  id: "user-1",
  accountId: "person.one",
  employeeId: "1001",
  status: "active",
  globalRole: "member",
  groups: ["engineering"],
  createdAt: 1,
  updatedAt: 1,
};

async function fixture(groups: string[] = ["engineering"], governance?: SkillHubGovernanceClient) {
  const workspaceRoot = tempDirs.make("platformclaw-skill-hub-");
  const skillDir = path.join(workspaceRoot, "agent-1", "skills", "demo-skill");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    "---\nname: demo-skill\ndescription: Demo skill\nversion: 0.0.1\n---\nInstructions\n",
  );
  await writeFile(path.join(skillDir, "helper.txt"), "hello");

  const authenticateToken = vi.fn(async () => ({
    status: "active" as const,
    session: {
      id: "session-1",
      userId: user.id,
      tokenHash: "hash",
      createdAt: 1,
      lastSeenAt: 1,
      idleExpiresAt: 2,
      absoluteExpiresAt: 2,
    },
    user: { ...user, groups },
  }));
  const recordAuditEvent = vi.fn(async (params) => ({ id: "audit-1", ...params }));
  const getPersonalExecutionProfile = vi.fn<ControlPlaneStore["getPersonalExecutionProfile"]>(
    async () => null,
  );
  const getVmAllocationForAgent = vi.fn<
    ControlPlaneExecutionManagementStore["getVmAllocationForAgent"]
  >(async () => null);
  let ownership: SkillHubOwnership | null = null;
  const store = {
    getPersonalExecutionProfile,
    getPersonalAgentBinding: vi.fn(async () => ({
      id: "binding-1",
      kind: "personal" as const,
      userId: user.id,
      agentId: "agent-1",
      state: "active" as const,
      createdAt: 1,
      updatedAt: 1,
    })),
    resolveAuthenticatedKnoxDmRoute: vi.fn(async () => ({
      status: "resolved" as const,
      user: { ...user, groups },
      binding: {
        id: "binding-1",
        kind: "personal" as const,
        userId: user.id,
        agentId: "agent-1",
        state: "active" as const,
        createdAt: 1,
        updatedAt: 1,
      },
      sessionKey: "agent:agent-1:main",
      executionTarget: "platform_server" as const,
    })),
    getVmAllocationForAgent,
    getSkillHubOwnership: vi.fn(async () => ownership),
    recordSkillHubPublication: vi.fn(async (params) => {
      ownership = {
        namespace: params.namespace,
        slug: params.slug,
        ownerUserId: ownership?.ownerUserId ?? params.ownerUserId,
        visibility: params.visibility,
        currentVersion: params.version,
        updatedAt: params.changedAt,
      };
      return ownership;
    }),
    reconcileInactiveSkillHubOwners: vi.fn(async () => ({ reassigned: 0, unassigned: 0 })),
    hasSkillHubAccess: vi.fn(async () => false),
    listSkillHubAccess: vi.fn(async () => []),
    countUnreadSkillHubNotifications: vi.fn(async () => 0),
    countUnassignedSkillHubSkills: vi.fn(async () => 0),
    listUnassignedSkillHubSkills: vi.fn(async () => []),
    getSkillHubNamespaceBinding: vi.fn(async () => null),
    listSkillHubNamespaceBindings: vi.fn(async () => []),
    hasSkillHubNamespaceAccess: vi.fn(async () => false),
    listManagedScopes: vi.fn(async () => []),
    enqueueSkillHubGovernanceJob: vi.fn(async () => undefined),
    listDueSkillHubGovernanceJobs: vi.fn(async () => []),
    updateSkillHubGovernanceJob: vi.fn(async () => undefined),
    createSkillHubNotification: vi.fn(async (params) => ({
      id: "notification-1",
      kind: params.kind,
      message: params.message,
      createdAt: params.createdAt,
    })),
    recordAuditEvent,
  } as unknown as SkillHubStore;
  const adapterMocks = {
    search: vi.fn<SkillHubAdapter["search"]>(async () => ({ items: [], total: 0 })),
    getSkill: vi.fn(async () => ({
      id: 10,
      namespace: "engineering",
      slug: "demo-skill",
      displayName: "Demo Skill",
      summary: "Demo",
      visibility: "PUBLIC",
      status: "PUBLISHED",
    })),
    listVersions: vi.fn<SkillHubAdapter["listVersions"]>(async () => []),
    listSecurityAudits: vi.fn<SkillHubAdapter["listSecurityAudits"]>(async () => []),
    publish: vi.fn(async (params) => ({
      namespace: params.namespace,
      slug: "demo-skill",
      version: "1.2.3",
      visibility: params.visibility,
    })),
    download: vi.fn(),
  };
  const adapter = adapterMocks as SkillHubAdapter;
  const adminRpcCall = vi.fn();
  const adminRpc = { call: adminRpcCall } as unknown as GatewayAdminRpc;
  const service = new SkillHubService({
    authService: { authenticateToken } as unknown as BrowserAuthService,
    store,
    adapter,
    adminRpc,
    workspaceRoot,
    allowedNamespaces: ["engineering"],
    maxPackageBytes: 1024 * 1024,
    now: () => 100,
    ...(governance ? { governance } : {}),
  });
  const actor = await service.authenticate("session-token");
  if (!actor) {
    throw new Error("fixture authentication failed");
  }
  return {
    workspaceRoot,
    store,
    skillDir,
    service,
    actor,
    adapterMocks,
    adminRpcCall,
    recordAuditEvent,
    getPersonalExecutionProfile,
    getVmAllocationForAgent,
  };
}

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
    expect(await readFile(path.join(skillDir, "SKILL.md"), "utf8")).toContain("version: 0.0.1");
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "skill-hub.publish", actorUserId: user.id }),
    );
  });

  it("rejects a configured namespace when the member lacks its publish group", async () => {
    const { service, actor, adapterMocks } = await fixture([]);
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
    const { workspaceRoot, actor, adapterMocks, adminRpcCall, store } = await fixture();
    const service = new SkillHubService({
      authService: { authenticateToken: vi.fn() } as unknown as BrowserAuthService,
      store: {
        ...store,
        getPersonalExecutionProfile: vi.fn(async () => null),
      } as unknown as SkillHubStore,
      adapter: adapterMocks as SkillHubAdapter,
      adminRpc: { call: adminRpcCall } as unknown as GatewayAdminRpc,
      workspaceRoot,
      allowedNamespaces: ["engineering"],
      maxPackageBytes: 1024,
    });
    adapterMocks.download.mockResolvedValue(
      overwriteCentralUncompressedSize(
        await skillArchive({ extra: (zip) => zip.file("large.txt", "x".repeat(4096)) }),
        "large.txt",
        1,
      ),
    );

    await expect(
      service.install(actor, {
        namespace: "engineering",
        slug: "demo-skill",
        version: "1.0.0",
        destination: "platform_server",
      }),
    ).rejects.toThrow(/oversized entry|expands past/u);
    expect(adminRpcCall).toHaveBeenCalledOnce();
    expect(adminRpcCall).toHaveBeenCalledWith(
      "skills.status",
      expect.objectContaining({ backendTarget: "platform_server", refresh: true }),
    );
  });

  it("uploads a validated exact version through the existing Gateway skill installer", async () => {
    const { service, actor, adapterMocks, adminRpcCall } = await fixture();
    adapterMocks.download.mockResolvedValue(await skillArchive());
    adminRpcCall.mockImplementation(async (method) => {
      if (method === "skills.upload.begin") {
        return { uploadId: "upload-1" };
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

  it("returns a no-op when the requested target already has the exact version", async () => {
    const { service, actor, adapterMocks, adminRpcCall } = await fixture();
    adminRpcCall.mockResolvedValue({
      skills: [{ skillKey: "demo-skill", source: "openclaw-workspace", version: "1.0.0" }],
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
      noOp: true,
      slug: "demo-skill",
      version: "1.0.0",
      target: "platform_server",
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
        return { uploadId: "upload-update" };
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
        code: "version-change-required",
        currentVersion: "1.0.0",
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
        acknowledgedVersionChange: true,
        currentVersion: "1.0.0",
      }),
    ).resolves.toMatchObject({ ok: true, noOp: false, version: "2.0.0" });
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
        return { uploadId: "upload-1" };
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
        return { uploadId: "upload-1" };
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

  it("rejects publishing while the authoritative target is an assigned VM", async () => {
    const { service, actor, adapterMocks, getPersonalExecutionProfile } = await fixture();
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
        namespace: "engineering",
        version: "1.0.0",
        visibility: "PUBLIC",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(adapterMocks.publish).not.toHaveBeenCalled();
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

  it("filters and blocks restricted skills for users outside the namespace group", async () => {
    const { service, actor, adapterMocks, adminRpcCall } = await fixture([]);
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
      visibility: "NAMESPACE_ONLY",
      status: "PUBLISHED",
    });

    await expect(service.search(actor.user, "demo")).resolves.toEqual({ items: [], total: 0 });
    await expect(service.detail(actor.user, "engineering", "demo-skill")).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(
      service.install(actor, {
        namespace: "engineering",
        slug: "demo-skill",
        version: "1.0.0",
        destination: "platform_server",
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
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
            previousOwnerId: "former-owner",
            changedAt: 99,
          },
        ],
      },
    );
  });
});
