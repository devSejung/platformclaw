import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { BrowserAuthService } from "./browser-auth-service.js";
import type { GatewayAdminRpc } from "./gateway-admin-rpc-client.js";
import type { OrganizationService } from "./organization-service.js";
import { IflytekSkillHubAdapter } from "./skill-hub-adapter.js";
import type { SkillHubStore } from "./skill-hub-service-support.js";
import { SkillHubService } from "./skill-hub-service.js";

const servers: Server[] = [];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
});

describe("PlatformClaw Skill Hub integration", () => {
  it("publishes a workspace ZIP and installs an exact registry version through Gateway upload RPC", async () => {
    const downloadZip = new JSZip();
    downloadZip.file(
      "SKILL.md",
      "---\nname: demo-skill\ndescription: Downloaded demo\nversion: 2.0.0\n---\nInstructions\n",
    );
    const downloadArchive = await downloadZip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      platform: "UNIX",
    });
    const requests: Array<{
      method: string;
      url: string;
      authorization?: string;
      contentType?: string;
    }> = [];
    const registry = createServer((req, res) => {
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        ...(typeof req.headers.authorization === "string"
          ? { authorization: req.headers.authorization }
          : {}),
        ...(typeof req.headers["content-type"] === "string"
          ? { contentType: req.headers["content-type"] }
          : {}),
      });
      if (req.method === "POST" && req.url === "/api/cli/v1/skills/engineering/publish") {
        req.resume();
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            code: 0,
            data: {
              id: 10,
              namespace: "engineering",
              slug: "demo-skill",
              version: "2.0.0",
              visibility: "PUBLIC",
            },
          }),
        );
        return;
      }
      if (req.method === "GET" && req.url === "/api/v1/skills/engineering/demo-skill") {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            code: 0,
            data: {
              id: 10,
              namespace: "engineering",
              slug: "demo-skill",
              displayName: "Demo Skill",
              summary: "Demo",
              visibility: "PUBLIC",
              status: "PUBLISHED",
            },
          }),
        );
        return;
      }
      if (
        req.method === "GET" &&
        req.url === "/api/cli/v1/skills/engineering/demo-skill/versions/2.0.0/download"
      ) {
        res.setHeader("Content-Type", "application/zip");
        res.setHeader("Content-Length", String(downloadArchive.byteLength));
        res.end(downloadArchive);
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    servers.push(registry);
    await new Promise<void>((resolve) => {
      registry.listen(0, "127.0.0.1", () => {
        resolve();
      });
    });
    const address = registry.address();
    if (!address || typeof address === "string") {
      throw new Error("registry fixture did not listen");
    }

    const workspaceRoot = tempDirs.make("platformclaw-skill-hub-integration-");
    const skillDir = path.join(workspaceRoot, "agent-one", "skills", "demo-skill");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: demo-skill\ndescription: Local demo\nversion: 1.0.0\n---\nInstructions\n",
    );

    const rpcCalls: Array<[string, unknown]> = [];
    const adminRpc: GatewayAdminRpc = {
      async call<T>(method: string, params: unknown): Promise<T> {
        rpcCalls.push([method, params]);
        if (method === "skills.upload.begin") {
          return { uploadId: "upload-one", receivedBytes: 0 } as T;
        }
        if (method === "skills.install") {
          return { ok: true, slug: "demo-skill" } as T;
        }
        return { ok: true } as T;
      },
    };
    const authService = {
      authenticateToken: vi.fn(async () => ({
        status: "active",
        user: { id: "user-one", status: "active", globalRole: "member", groups: ["engineering"] },
      })),
    } as unknown as BrowserAuthService;
    const store = {
      getPersonalExecutionProfile: vi.fn(async () => null),
      getVmAllocationForAgent: vi.fn(async () => null),
      getPersonalAgentBinding: vi.fn(async () => ({
        id: "binding-one",
        kind: "personal",
        userId: "user-one",
        agentId: "agent-one",
        state: "active",
        createdAt: 1,
        updatedAt: 1,
      })),
      recordAuditEvent: vi.fn(async (params) => ({ id: "audit-one", ...params })),
      getSkillHubOwnership: vi.fn(async () => null),
      recordSkillHubPublication: vi.fn(async (params) => ({
        namespace: params.namespace,
        slug: params.slug,
        ownerUserId: params.ownerUserId,
        visibility: params.visibility,
        currentVersion: params.version,
        updatedAt: params.changedAt,
      })),
      reconcileInactiveSkillHubOwners: vi.fn(async () => ({ reassigned: 0, unassigned: 0 })),
      hasSkillHubAccess: vi.fn(async () => false),
      searchSkillHubManagementUsers: vi.fn(async () => []),
      getSkillHubNamespaceBinding: vi.fn(async () => ({
        namespace: "engineering",
        scopeKind: "team" as const,
        scopeId: "team-engineering",
        accessState: "active" as const,
        visibilityCeiling: "PUBLIC" as const,
        createdByUserId: "admin-one",
        createdAt: 1,
        updatedAt: 1,
      })),
      enqueueSkillHubGovernanceJob: vi.fn(async () => undefined),
    } as unknown as SkillHubStore;
    const service = new SkillHubService({
      authService,
      store,
      adapter: new IflytekSkillHubAdapter({
        baseUrl: `http://127.0.0.1:${address.port}`,
        token: "registry-server-token",
        maxArchiveBytes: 1024 * 1024,
      }),
      adminRpc,
      workspaceRoot,
      allowedNamespaces: ["engineering"],
      organization: {
        authorization: {
          authorizeManagedScope: vi.fn(async () => ({
            canRead: true,
            canManageMembers: false,
            canManageStructure: false,
            canManageLeaders: false,
            facts: { source: "membership" as const, scopeIds: ["team-engineering"] },
          })),
        },
        listScopes: vi.fn(async () => []),
      } as unknown as OrganizationService,
      maxPackageBytes: 1024 * 1024,
    });
    const actor = await service.authenticate("browser-session");
    if (!actor) {
      throw new Error("actor authentication failed");
    }

    await expect(
      service.publish(actor, {
        skill: "demo-skill",
        namespace: "engineering",
        version: "2.0.0",
        visibility: "PUBLIC",
      }),
    ).resolves.toMatchObject({ version: "2.0.0" });
    await expect(
      service.install(actor, {
        namespace: "engineering",
        slug: "demo-skill",
        version: "2.0.0",
        destination: "platform_server",
      }),
    ).resolves.toMatchObject({ ok: true });

    expect(requests).toEqual([
      expect.objectContaining({
        method: "POST",
        url: "/api/cli/v1/skills/engineering/publish",
        authorization: "Bearer registry-server-token",
        contentType: expect.stringContaining("multipart/form-data"),
      }),
      expect.objectContaining({
        method: "GET",
        url: "/api/v1/skills/engineering/demo-skill",
        authorization: "Bearer registry-server-token",
      }),
      expect.objectContaining({
        method: "GET",
        url: "/api/cli/v1/skills/engineering/demo-skill/versions/2.0.0/download",
        authorization: "Bearer registry-server-token",
      }),
      expect.objectContaining({
        method: "GET",
        url: "/api/v1/skills/engineering/demo-skill",
        authorization: "Bearer registry-server-token",
      }),
    ]);
    expect(rpcCalls.map(([method]) => method)).toEqual([
      "skills.status",
      "skills.upload.begin",
      "skills.upload.chunk",
      "skills.upload.commit",
      "skills.install",
    ]);
  });
});
