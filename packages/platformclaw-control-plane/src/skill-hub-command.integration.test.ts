import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearPluginCommands,
  executePluginCommand,
  matchPluginCommand,
  registerPluginCommand,
} from "../../../src/plugin-sdk/plugin-runtime.js";
import type { OpenClawPluginApi } from "../../../src/plugins/types.js";
import { resolveRelativeBundledPluginPublicModuleId } from "../../../src/test-utils/bundled-plugin-public-surface.js";
import { readBrowserJsonBody } from "./browser-http-shared.js";
import type { KnoxRoutingService } from "./knox-routing-service.js";
import { handlePlatformClawKnoxInternalRequest } from "./knox-skill-hub-http.js";
import { createSkillHubServiceFixture } from "./skill-hub-service.test-fixtures.js";

// Load the source entry through its public boundary without extending the core TypeScript graph.
const skillHubModuleId = resolveRelativeBundledPluginPublicModuleId({
  fromModuleUrl: import.meta.url,
  pluginId: "platformclaw-skillhub",
  artifactBasename: "index.js",
});
const { default: skillHubPlugin } = (await import(skillHubModuleId)) as {
  default: { register(api: OpenClawPluginApi): void };
};

const servers: Server[] = [];
afterEach(async () => {
  clearPluginCommands();
  vi.unstubAllEnvs();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

async function setup(enabled = true, room = false) {
  const fixture = await createSkillHubServiceFixture();
  const roomBinding = {
    id: "room-binding",
    kind: "knox-room" as const,
    accountId: "default",
    roomId: "group-1",
    agentId: "room-agent",
    state: "active" as const,
    createdAt: 1,
    updatedAt: 1,
  };
  fixture.store.getUserByAccountId = vi.fn(async (id) =>
    id === "person.one" ? fixture.actor.user : null,
  );
  fixture.store.listAgentBindingsByState = vi.fn(async () => [roomBinding]);
  const agentId = room ? roomBinding.agentId : "agent-1";
  const skillDir = room
    ? path.join(fixture.workspaceRoot, agentId, "skills", "demo-skill")
    : fixture.skillDir;
  await mkdir(skillDir, { recursive: true });
  const serviceToken = "test-service-token-".repeat(3);
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? "");
    void handlePlatformClawKnoxInternalRequest(req, res, {
      service: {} as KnoxRoutingService,
      skillHubService: enabled ? fixture.service : undefined,
      serviceToken,
      readJsonBody: readBrowserJsonBody,
    })
      .then((handled) => {
        if (!handled) {
          res.statusCode = 404;
          res.end();
        }
      })
      .catch(() => {
        res.statusCode = 500;
        res.end();
      });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("missing server address");
  }
  const endpoint = `http://127.0.0.1:${address.port}/platformclaw/internal/knox/skillhub`;
  const tokenFile = path.join(fixture.workspaceRoot, "service-token");
  await writeFile(tokenFile, serviceToken);
  vi.stubEnv("PLATFORMCLAW_KNOX_SERVICE_TOKEN_FILE", tokenFile);
  vi.stubEnv("PLATFORMCLAW_KNOX_CONTROL_PLANE_URL", endpoint);
  clearPluginCommands();
  skillHubPlugin.register({
    registrationMode: "full",
    registerCommand: (command: Parameters<typeof registerPluginCommand>[1]) => {
      expect(registerPluginCommand("platformclaw-skillhub", command)).toMatchObject({ ok: true });
    },
    logger: { warn: vi.fn() },
  } as never);
  const run = async (
    args: string,
    extra: { authorized?: boolean; target?: string; senderId?: string } = {},
  ) => {
    const commandBody = `/skillhub ${args}`.trim();
    const match = matchPluginCommand(commandBody, { channel: "knox" });
    expect(match).not.toBeNull();
    const reply = await executePluginCommand({
      command: match!.command,
      args: match!.args,
      commandBody,
      senderId: extra.senderId ?? "person.one",
      channel: "knox",
      config: {},
      isAuthorizedSender: extra.authorized ?? true,
      from: extra.target ?? (room ? "room:group-1" : "dm:42"),
      to: extra.target ?? (room ? "room:group-1" : "dm:42"),
      agentId,
      accountId: "default",
      sessionKey: `agent:${agentId}:main`,
    });
    expect(reply.continueAgent).not.toBe(true);
    return reply;
  };
  return { ...fixture, agentId, skillDir, run, requests, endpoint };
}

describe("Knox Skill Hub command transport", () => {
  it.each([false, true])(
    "executes all seven verbs through plugin dispatch, HTTP and service (room=%s)",
    async (room) => {
      const f = await setup(true, room);
      f.adapterMocks.search.mockResolvedValue({
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
      f.adapterMocks.listVersions.mockResolvedValue([
        { id: 1, version: "1.0.0", status: "PUBLISHED", downloadAvailable: true },
      ]);
      const zip = new JSZip();
      zip.file(
        "SKILL.md",
        "---\nname: demo-skill\ndescription: Demo\nversion: 1.0.0\n---\nInstructions",
      );
      f.adapterMocks.download.mockResolvedValue(
        await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
      );
      let installed = false;
      f.adminRpcCall.mockImplementation(async (method) => {
        if (method === "skills.status") {
          return {
            skills: installed
              ? [
                  {
                    skillKey: "demo-skill",
                    source: "openclaw-workspace",
                    version: "1.0.0",
                    revision: "sha256:1111111111111111",
                  },
                ]
              : [],
          };
        }
        if (method === "skills.upload.begin") {
          return { uploadId: "upload-1", receivedBytes: 0 };
        }
        if (method === "skills.install") {
          installed = true;
          return { ok: true, slug: "demo-skill" };
        }
        if (method === "skills.uninstall") {
          installed = false;
          return { ok: true, slug: "demo-skill" };
        }
        return { ok: true };
      });
      expect((await f.run("help")).text).toContain("SkillHub 명령어");
      expect((await f.run("help en")).text).toContain("SkillHub commands");
      expect((await f.run("list all")).text).toContain("engineering");
      expect((await f.run("install engineering/demo-skill")).text).toContain("설치 완료");
      expect((await f.run("installed")).text).toContain("demo-skill");
      expect((await f.run("update demo-skill")).text).toContain("업데이트 완료");
      expect(f.adminRpcCall).toHaveBeenCalledWith(
        "skills.install",
        expect.objectContaining({
          agentId: f.agentId,
          force: true,
          expectedSkillRevision: "sha256:1111111111111111",
        }),
      );
      // Publish uses the same active workspace and organization policy as the UI.
      await writeFile(
        path.join(f.skillDir, "SKILL.md"),
        "---\nname: demo-skill\ndescription: Demo\nversion: 1.0.0\n---\nInstructions",
      );
      f.adapterMocks.publish.mockResolvedValue({
        namespace: "engineering",
        slug: "demo-skill",
        version: "1.0.0",
        visibility: "NAMESPACE_ONLY",
      });
      expect((await f.run("publish demo-skill")).text).toContain("게시 완료");
      expect((await f.run("delete demo-skill")).isError).toBe(true);
      expect(f.adminRpcCall).not.toHaveBeenCalledWith("skills.uninstall", expect.anything());
      expect((await f.run("delete demo-skill --confirm")).text).toContain("설치 제거 완료");
      expect(f.adminRpcCall).toHaveBeenCalledWith(
        "skills.uninstall",
        expect.objectContaining({
          agentId: f.agentId,
          expectedSkillRevision: "sha256:1111111111111111",
        }),
      );
      expect(f.requests).toHaveLength(9);
      for (const [method, params] of f.adminRpcCall.mock.calls) {
        if (
          method === "skills.status" ||
          method === "skills.install" ||
          method === "skills.uninstall"
        ) {
          expect(params.agentId).toBe(f.agentId);
          if (room) {
            expect(params).not.toHaveProperty("backendTarget");
          } else {
            expect(params.backendTarget).toBe("platform_server");
          }
        }
      }
    },
  );

  it("denies unauthorized senders and mismatched room targets before private queries or mutation", async () => {
    const f = await setup();
    expect((await f.run("list", { authorized: false })).text).toBeTruthy();
    expect((await f.run("list", { target: "room:group-1" })).text).toBeTruthy();
    expect((await f.run("install demo-skill", { target: "room:group-1" })).isError).toBe(true);
    expect(f.requests).toHaveLength(2);
    expect(f.adapterMocks.search).not.toHaveBeenCalled();
    expect(f.adminRpcCall).not.toHaveBeenCalled();
    expect(matchPluginCommand("/skillhub list", { channel: "webchat" })).toBeNull();
    expect(matchPluginCommand("Please run /skillhub list", { channel: "knox" })).toBeNull();
  });

  it("gives explicit unavailable, unauthenticated and legacy-category outcomes", async () => {
    const f = await setup(false);
    expect((await f.run("list")).text).toContain("활성화되어 있지 않습니다");
    const unauthenticated = await fetch(f.endpoint, { method: "POST", body: "{}" });
    expect(unauthenticated.status).toBe(401);
    expect(f.adapterMocks.search).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "keeps catalog pages in registry order without dropping visible skills (room=%s)",
    async (room) => {
      const f = await setup(true, room);
      const items = Array.from({ length: 41 }, (_, index) => ({
        namespace: "engineering",
        slug: `skill-${index + 1}`,
        latestVersion: "1.0.0",
        summary: "Demo",
        visibility: index >= 20 && index % 2 === 0 ? ("PUBLIC" as const) : ("PRIVATE" as const),
      }));
      f.adapterMocks.search.mockImplementation(async (_query, limit) => ({
        items: items.slice(0, limit),
        total: items.length,
      }));
      const pages: string[] = [];
      for (const page of [1, 2, 3]) {
        pages.push((await f.run(`list ${page}`)).text ?? "");
      }
      expect(pages[0]).toContain("/skillhub list 2");
      expect(pages[1]).toContain("/skillhub list 3");
      expect(pages[2]).not.toContain("/skillhub list 4");
      const shown = pages.flatMap((text) =>
        [...text.matchAll(/`(skill-\d+)`/gu)].map((match) => match[1]),
      );
      expect(shown).toEqual(
        items.filter((item) => item.visibility === "PUBLIC").map((item) => item.slug),
      );
      expect(f.adapterMocks.search.mock.calls.map((call) => call[1])).toEqual([20, 40, 60]);
    },
  );

  it.each(["PRIVATE", "NAMESPACE_ONLY"] as const)(
    "keeps %s skills and personal grants out of room search/install",
    async (visibility) => {
      const f = await setup(true, true);
      f.actor.user.globalRole = "admin";
      vi.spyOn(f.store, "hasSkillHubAccess").mockResolvedValue(true);
      f.adapterMocks.search.mockResolvedValue({
        items: [
          {
            namespace: "engineering",
            slug: "restricted",
            latestVersion: "1.0.0",
            summary: "secret",
            visibility,
          },
        ],
        total: 1,
      });
      f.adapterMocks.getSkill.mockResolvedValue({
        id: 10,
        namespace: "engineering",
        slug: "restricted",
        displayName: "Restricted",
        summary: "secret",
        visibility,
        status: "PUBLISHED",
      });
      const list = await f.run("list");
      expect(list.text).not.toContain("restricted");
      expect((await f.run("install engineering/restricted")).isError).toBe(true);
      expect((await f.run("update restricted")).isError).toBe(true);
      expect(f.adapterMocks.download).not.toHaveBeenCalled();
      expect(f.adminRpcCall).not.toHaveBeenCalled();
    },
  );

  it.each(["disabled", "reassigned"] as const)(
    "rejects a DM binding %s during download before install commit",
    async (change) => {
      const f = await setup();
      f.adapterMocks.listVersions.mockResolvedValue([
        { id: 1, version: "1.0.0", status: "PUBLISHED", downloadAvailable: true },
      ]);
      const zip = new JSZip();
      zip.file(
        "SKILL.md",
        "---\nname: demo-skill\ndescription: Demo\nversion: 1.0.0\n---\nInstructions",
      );
      const bytes = await zip.generateAsync({ type: "nodebuffer" });
      f.adapterMocks.download.mockImplementation(async () => {
        const current = await f.store.getPersonalAgentBinding(f.actor.user.id);
        vi.spyOn(f.store, "getPersonalAgentBinding").mockResolvedValue(
          current
            ? {
                ...current,
                ...(change === "disabled"
                  ? { state: "disabled" as const }
                  : { agentId: "other-agent" }),
              }
            : null,
        );
        return bytes;
      });
      f.adminRpcCall.mockImplementation(async (method) =>
        method === "skills.upload.begin"
          ? { uploadId: "upload-1", receivedBytes: 0 }
          : { ok: true, slug: "demo-skill" },
      );
      expect((await f.run("install engineering/demo-skill")).isError).toBe(true);
      expect(f.adminRpcCall).not.toHaveBeenCalledWith("skills.install", expect.anything());
    },
  );

  it("rechecks public visibility after download before committing a room installation", async () => {
    const f = await setup(true, true);
    const publicSkill = {
      id: 10,
      namespace: "engineering",
      slug: "demo-skill",
      displayName: "Demo",
      summary: "Demo",
      visibility: "PUBLIC",
      status: "PUBLISHED",
    };
    f.adapterMocks.getSkill
      .mockResolvedValueOnce(publicSkill)
      .mockResolvedValueOnce(publicSkill)
      .mockResolvedValue({ ...publicSkill, visibility: "PRIVATE" });
    f.adapterMocks.listVersions.mockResolvedValue([
      { id: 1, version: "1.0.0", status: "PUBLISHED", downloadAvailable: true },
    ]);
    const zip = new JSZip();
    zip.file(
      "SKILL.md",
      "---\nname: demo-skill\ndescription: Demo\nversion: 1.0.0\n---\nInstructions",
    );
    f.adapterMocks.download.mockResolvedValue(await zip.generateAsync({ type: "nodebuffer" }));
    f.adminRpcCall.mockImplementation(async (method) =>
      method === "skills.upload.begin" ? { uploadId: "upload-1", receivedBytes: 0 } : { ok: true },
    );
    expect((await f.run("install engineering/demo-skill")).isError).toBe(true);
    expect(f.adminRpcCall).not.toHaveBeenCalledWith("skills.install", expect.anything());
  });

  it.each(["knowledge", "automation", "utility", "other"])(
    "explains unsupported legacy category %s without inventing a filter",
    async (category) => {
      const f = await setup();
      const reply = await f.run(`list ${category}`);
      expect(reply).toMatchObject({
        isError: true,
        text: expect.stringContaining("/skillhub list [페이지]"),
      });
      expect(f.adapterMocks.search).not.toHaveBeenCalled();
    },
  );
});
