import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserAuthService } from "./browser-auth-service.js";
import type { ControlPlaneAuditWriter, ControlPlaneStore, PlatformUser } from "./contracts.js";
import type { GatewayAdminRpc } from "./gateway-admin-rpc-client.js";
import type { SkillHubAdapter } from "./skill-hub-adapter.js";
import { SkillHubService, SkillHubServiceError } from "./skill-hub-service.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

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
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "platformclaw-skill-hub-"));
  roots.push(workspaceRoot);
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
  const store = {
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
  const adapter: SkillHubAdapter = {
    search: vi.fn(async () => ({ items: [], total: 0 })),
    getSkill: vi.fn(async () => ({})),
    listVersions: vi.fn(async () => []),
    publish: vi.fn(async (params) => ({
      namespace: params.namespace,
      slug: "demo-skill",
      version: "1.2.3",
      visibility: params.visibility,
    })),
    download: vi.fn(),
  };
  const adminRpc = { call: vi.fn() } as unknown as GatewayAdminRpc;
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
  return { workspaceRoot, skillDir, service, actor, adapter, adminRpc, recordAuditEvent };
}

async function skillArchive(
  params: {
    name?: string;
    extra?: (zip: JSZip) => void;
    body?: string;
  } = {},
): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "SKILL.md",
    `---\nname: ${params.name ?? "demo-skill"}\ndescription: Demo\nversion: 1.0.0\n---\n${params.body ?? "Instructions"}`,
  );
  params.extra?.(zip);
  return await zip.generateAsync({ type: "nodebuffer", platform: "UNIX", compression: "DEFLATE" });
}

describe("SkillHubService", () => {
  it("packages the real workspace skill and overrides only the published version", async () => {
    const { service, actor, adapter, skillDir, recordAuditEvent } = await fixture();

    await expect(
      service.publish(actor, {
        skill: "demo-skill",
        namespace: "engineering",
        version: "1.2.3",
        visibility: "NAMESPACE_ONLY",
      }),
    ).resolves.toMatchObject({ slug: "demo-skill", version: "1.2.3" });

    const publish = vi.mocked(adapter.publish);
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
    const { service, actor, adapter } = await fixture([]);
    await expect(
      service.publish(actor, {
        skill: "demo-skill",
        namespace: "engineering",
        version: "1.0.0",
        visibility: "PUBLIC",
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(adapter.publish).not.toHaveBeenCalled();
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
    const { service, actor, adapter, adminRpc } = await fixture();
    vi.mocked(adapter.download).mockResolvedValue(await makeArchive());

    await expect(
      service.install(actor, { namespace: "engineering", slug: "demo-skill", version: "1.0.0" }),
    ).rejects.toBeInstanceOf(SkillHubServiceError);
    expect(adminRpc.call).not.toHaveBeenCalled();
  });

  it("blocks a compressed archive whose extracted size exceeds the package limit", async () => {
    const { workspaceRoot, actor, adapter, adminRpc } = await fixture();
    const service = new SkillHubService({
      authService: { authenticateToken: vi.fn() } as unknown as BrowserAuthService,
      store: {} as ControlPlaneStore & ControlPlaneAuditWriter,
      adapter,
      adminRpc,
      workspaceRoot,
      allowedNamespaces: ["engineering"],
      maxPackageBytes: 1024,
    });
    vi.mocked(adapter.download).mockResolvedValue(
      await skillArchive({ extra: (zip) => zip.file("large.txt", "x".repeat(4096)) }),
    );

    await expect(
      service.install(actor, { namespace: "engineering", slug: "demo-skill", version: "1.0.0" }),
    ).rejects.toThrow("expands past");
    expect(adminRpc.call).not.toHaveBeenCalled();
  });

  it("uploads a validated exact version through the existing Gateway skill installer", async () => {
    const { service, actor, adapter, adminRpc } = await fixture();
    vi.mocked(adapter.download).mockResolvedValue(await skillArchive());
    vi.mocked(adminRpc.call).mockImplementation(async (method) => {
      if (method === "skills.upload.begin") {
        return { uploadId: "upload-1" };
      }
      if (method === "skills.install") {
        return { ok: true, slug: "demo-skill" };
      }
      return { ok: true };
    });

    await expect(
      service.install(actor, { namespace: "engineering", slug: "demo-skill", version: "1.0.0" }),
    ).resolves.toMatchObject({ ok: true });
    expect(vi.mocked(adminRpc.call).mock.calls.map(([method]) => method)).toEqual([
      "skills.upload.begin",
      "skills.upload.chunk",
      "skills.upload.commit",
      "skills.install",
    ]);
    expect(adminRpc.call).toHaveBeenLastCalledWith(
      "skills.install",
      expect.objectContaining({ agentId: "agent-1", source: "upload", force: false }),
    );
  });
});
