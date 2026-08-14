import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { BrowserAuthService } from "./browser-auth-service.js";
import type { ControlPlaneAuditWriter, ControlPlaneStore, PlatformUser } from "./contracts.js";
import type { GatewayAdminRpc } from "./gateway-admin-rpc-client.js";
import type { SkillHubAdapter } from "./skill-hub-adapter.js";
import { SkillHubService, SkillHubServiceError } from "./skill-hub-service.js";

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

async function fixture(groups: string[] = ["engineering"]) {
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
    recordAuditEvent,
  } as unknown as ControlPlaneStore & ControlPlaneAuditWriter;
  const adapterMocks = {
    search: vi.fn<SkillHubAdapter["search"]>(async () => ({ items: [], total: 0 })),
    getSkill: vi.fn(async () => ({
      namespace: "engineering",
      slug: "demo-skill",
      displayName: "Demo Skill",
      summary: "Demo",
      visibility: "PUBLIC",
      status: "PUBLISHED",
    })),
    listVersions: vi.fn(async () => []),
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
  });
  const actor = await service.authenticate("session-token");
  if (!actor) {
    throw new Error("fixture authentication failed");
  }
  return {
    workspaceRoot,
    skillDir,
    service,
    actor,
    adapterMocks,
    adminRpcCall,
    recordAuditEvent,
    getPersonalExecutionProfile,
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
        expectedTarget: "platform_server",
      }),
    ).rejects.toBeInstanceOf(SkillHubServiceError);
    expect(adminRpcCall).not.toHaveBeenCalled();
  });

  it("streams to the package limit even when ZIP metadata understates extracted size", async () => {
    const { workspaceRoot, actor, adapterMocks, adminRpcCall } = await fixture();
    const service = new SkillHubService({
      authService: { authenticateToken: vi.fn() } as unknown as BrowserAuthService,
      store: {
        getPersonalExecutionProfile: vi.fn(async () => null),
      } as unknown as ControlPlaneStore & ControlPlaneAuditWriter,
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
        expectedTarget: "platform_server",
      }),
    ).rejects.toThrow("expands past");
    expect(adminRpcCall).not.toHaveBeenCalled();
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
        expectedTarget: "platform_server",
      }),
    ).resolves.toEqual({
      ok: true,
      slug: "demo-skill",
      version: "1.0.0",
      target: "platform_server",
    });
    expect(adminRpcCall.mock.calls.map(([method]) => method)).toEqual([
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

  it("pins an assigned VM target without exposing the Gateway destination", async () => {
    const { service, actor, adapterMocks, adminRpcCall, getPersonalExecutionProfile } =
      await fixture();
    getPersonalExecutionProfile.mockResolvedValue({
      agentBindingId: "binding-1",
      activeTarget: "assigned_vm",
      activeAllocationId: "allocation-1",
      targetRevision: 7,
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
        expectedTarget: "assigned_vm",
      }),
    ).resolves.toEqual({
      ok: true,
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

  it("rejects a stale browser target before downloading", async () => {
    const { service, actor, adapterMocks, adminRpcCall, getPersonalExecutionProfile } =
      await fixture();
    getPersonalExecutionProfile.mockResolvedValue({
      agentBindingId: "binding-1",
      activeTarget: "assigned_vm",
      activeAllocationId: "allocation-1",
      targetRevision: 8,
      updatedAt: 1,
    });

    await expect(
      service.install(actor, {
        namespace: "engineering",
        slug: "demo-skill",
        version: "1.0.0",
        expectedTarget: "platform_server",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(adapterMocks.download).not.toHaveBeenCalled();
    expect(adminRpcCall).not.toHaveBeenCalled();
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
        expectedTarget: "platform_server",
      }),
    ).rejects.toThrow("does not match");
    expect(adminRpcCall).not.toHaveBeenCalled();
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
        expectedTarget: "platform_server",
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(adapterMocks.download).not.toHaveBeenCalled();
    expect(adminRpcCall).not.toHaveBeenCalled();
  });
});
