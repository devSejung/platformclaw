import { randomUUID } from "node:crypto";
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
import { KnoxRoutingService } from "./knox-routing-service.js";
import { handlePlatformClawKnoxInternalRequest } from "./knox-skill-hub-http.js";
import { SkillHubGovernanceError } from "./skill-hub-governance-client.js";
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

async function setup(enabled = true, room = false, manager?: "admin" | "owner") {
  const fixture = await createSkillHubServiceFixture();
  if (manager === "admin") {
    fixture.actor.user = (
      await fixture.store.addDeploymentAdministrator({
        accountId: fixture.actor.user.accountId,
        changedAt: 4,
      })
    ).user;
  }
  const reservation = await fixture.store.reserveKnoxRoomAgent({
    accountId: "default",
    roomId: "group-1",
    reservedAt: 5,
  });
  const roomBinding = reservation.binding;
  await fixture.store.transitionAgent({ bindingId: roomBinding.id, state: "active", changedAt: 6 });
  const agentId = room ? roomBinding.agentId : fixture.actor.agentId;
  const skillDir = room
    ? path.join(fixture.workspaceRoot, agentId, "skills", "demo-skill")
    : fixture.skillDir;
  await mkdir(skillDir, { recursive: true });
  const serviceToken = "test-service-token-".repeat(3);
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? "");
    void handlePlatformClawKnoxInternalRequest(req, res, {
      service: new KnoxRoutingService({
        store: fixture.store,
        roomProvisioner: { provision: async () => undefined },
        buildAgentMainSessionKey: ({ agentId: bindingAgentId }) => `agent:${bindingAgentId}:main`,
      }),
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
  const on = vi.fn<OpenClawPluginApi["on"]>();
  skillHubPlugin.register({
    registrationMode: "full",
    registerTool: vi.fn(),
    on,
    registerCommand: (command: Parameters<typeof registerPluginCommand>[1]) => {
      expect(registerPluginCommand("platformclaw-skillhub", command)).toMatchObject({ ok: true });
    },
    logger: { warn: vi.fn() },
  } as never);
  expect(on).toHaveBeenCalledExactlyOnceWith("before_skill_context", expect.any(Function));
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

async function archive(version = "1.0.0") {
  const zip = new JSZip();
  zip.file(
    "SKILL.md",
    `---\nname: demo-skill\ndescription: Demo\nversion: ${version}\n---\nInstructions`,
  );
  return await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

describe("Knox Skill Hub command transport", () => {
  it.each([
    ["list knowledge", "Page must be 1 to 25", "페이지는 1부터 25까지"],
    ["install", "Usage: /skillhub install <skill-id|name>", "명령어 사용법"],
    ["publish missing-skill", "Workspace skill not found", "현재 작업 공간에 해당 스킬이 없습니다"],
    ["delete demo-skill", "Usage: /skillhub delete <installed-skill> --confirm", "명령어 사용법"],
  ])(
    "provides Korean recovery guidance and unchanged English diagnostics for %s",
    async (args, diagnostic, korean) => {
      const f = await setup();
      expect(await f.run(args)).toMatchObject({
        isError: true,
        text: expect.stringContaining(korean),
      });
      expect((await f.run(`--lang=ko ${args}`)).text).toContain(`오류 정보: ${diagnostic}`);
      expect(await f.run(`--lang=en ${args}`)).toMatchObject({ isError: true, text: diagnostic });
      expect(f.governanceMocks.publishArtifact).not.toHaveBeenCalled();
      expect(f.adapterMocks.download).not.toHaveBeenCalled();
      expect(f.adminRpcCall).not.toHaveBeenCalledWith("skills.uninstall", expect.anything());
    },
  );

  it("exposes English help and keeps the choice in next-page commands", async () => {
    const f = await setup();
    expect((await f.run("--lang=en")).text).toContain("## SkillHub commands");
    expect((await f.run("--lang=ko help")).text).toContain("## SkillHub 명령어");
    for (let index = 0; index < 20; index++) {
      await f.seedEntry({ slug: `page-${index}` });
    }
    expect((await f.run("--lang=en list")).text).toContain("/skillhub --lang=en list 2");
    expect((await f.run("list")).text).toContain("/skillhub list 2");
  });

  it("keeps an uncertain command publication recoverable instead of adopting a changed workspace", async () => {
    const f = await setup();
    f.service.close();
    f.adminRpcCall.mockResolvedValue({
      skills: [
        {
          skillKey: "demo-skill",
          source: "openclaw-workspace",
          baseDir: "/workspace/skills/demo-skill",
          version: "0.0.1",
        },
      ],
    });
    const nativePublish = f.governanceMocks.publishArtifact.getMockImplementation()!;
    f.governanceMocks.publishArtifact.mockImplementationOnce(async (params) => {
      await nativePublish(params);
      throw new SkillHubGovernanceError("Synthetic committed lost reply");
    });
    expect((await f.run("publish demo-skill")).isError).toBe(true);
    const [pending] = await f.store.skillHubCatalog.listRecoverablePublications(f.actor.user.id);
    expect(pending).toMatchObject({ slug: "demo-skill", version: "0.0.1", state: "pending" });
    const entries = await f.store.skillHubCatalog.list();
    const nativeKeys = [...f.native.keys()];

    // A retry may now target a VM or changed files. Neither is authority to
    // reuse the old immutable request or silently create a second publication.
    f.getPersonalExecutionProfile.mockResolvedValue({
      agentBindingId: "binding-1",
      activeTarget: "assigned_vm",
      activeAllocationId: "allocation-new",
      targetRevision: 9,
      updatedAt: 40,
    });
    await writeFile(
      path.join(f.skillDir, "SKILL.md"),
      "---\nname: demo-skill\ndescription: Changed\nversion: 9.0.0\n---\nChanged files",
    );
    f.adminRpcCall.mockClear();
    expect(await f.run("publish demo-skill")).toMatchObject({
      isError: true,
      text: expect.stringContaining(`demo-skill@0.0.1`),
    });
    const english = await f.service.commandForWorkspace(f.actor, "publish demo-skill", "en");
    expect(english).toMatchObject({ isError: true });
    expect(english.text).toContain(pending!.operationId);
    expect(english.text).toContain("Recover or cancel");
    expect(f.adminRpcCall).not.toHaveBeenCalled();
    expect(f.governanceMocks.publishArtifact).toHaveBeenCalledOnce();
    expect(await f.store.skillHubCatalog.list()).toEqual(entries);
    expect([...f.native.keys()]).toEqual(nativeKeys);
    expect((await f.service.config(f.actor)).pendingPublications).toEqual([
      expect.objectContaining({ operationId: pending!.operationId, isMine: true }),
    ]);

    // The real web recovery endpoint reconciles the committed version. Once
    // resolved, the user can intentionally publish an independent same-name skill.
    await expect(f.service.cancelPublication(f.actor.user, pending!.operationId)).rejects.toThrow(
      "already completed",
    );
    expect((await f.store.skillHubCatalog.getPublication(pending!.operationId))?.state).toBe(
      "completed",
    );
    f.getPersonalExecutionProfile.mockResolvedValue(null);
    expect((await f.run("publish demo-skill")).text).toContain("전체공개 게시 완료");
    expect(f.governanceMocks.publishArtifact).toHaveBeenCalledTimes(2);
    expect(await f.store.skillHubCatalog.list()).toHaveLength(entries.length + 1);
  });

  it.each(["foreign-owner", "another-publisher", "different-slug"] as const)(
    "allows independent publication when an unrelated pending request has %s",
    async (relationship) => {
      const f = await setup(true, false, "admin");
      f.service.close();
      const other = await f.createActor("other.owner");
      const pendingOwner = relationship === "foreign-owner" ? other.user.id : f.actor.user.id;
      const entry = await f.seedEntry({
        ownerUserId: pendingOwner,
        slug: relationship === "different-slug" ? "other-skill" : "demo-skill",
      });
      const publisher = relationship === "another-publisher" ? other : f.actor;
      if (relationship === "another-publisher") {
        publisher.user = (
          await f.store.addDeploymentAdministrator({
            accountId: publisher.user.accountId,
            changedAt: 20,
          })
        ).user;
      }
      const operationId = randomUUID();
      await f.store.skillHubCatalog.reservePublication({
        operationId,
        skillId: entry.id,
        actorUserId: publisher.user.id,
        slug: entry.slug,
        version: "3.0.0",
        fingerprint: operationId,
        expectedRevision: entry.revision,
        reason: "Help the current owner publish",
        now: 30,
      });
      f.adminRpcCall.mockResolvedValue({
        skills: [
          {
            skillKey: "demo-skill",
            source: "openclaw-workspace",
            baseDir: "/workspace/skills/demo-skill",
            version: "0.0.1",
          },
        ],
      });
      expect((await f.run("publish demo-skill")).text).toContain("전체공개 게시 완료");
      expect((await f.store.skillHubCatalog.getPublication(operationId))?.state).toBe("pending");
      expect(f.governanceMocks.publishArtifact).toHaveBeenCalledOnce();
    },
  );

  it("refuses automatic name selection when a second exact match lies beyond 500 accessible results", async () => {
    const f = await setup();
    const first = f.entry!;
    await f.store.skillHubCatalog.updateMetadata({
      skillId: first.id,
      actorUserId: f.actor.user.id,
      expectedRevision: first.revision,
      tags: ["exact-match"],
      now: 10_000,
    });
    for (let index = 0; index < 499; index++) {
      const entry = await f.seedEntry({ slug: `demo-skill-${index}` });
      await f.store.skillHubCatalog.updateMetadata({
        skillId: entry.id,
        actorUserId: f.actor.user.id,
        expectedRevision: entry.revision,
        tags: ["partial-match"],
        now: 100 + index,
      });
    }
    await f.seedEntry({ slug: "demo-skill" });
    const result = await f.service.search(f.actor.user, "demo-skill", 500);
    expect(result.total).toBe(501);
    expect(result.items.filter((item) => item.slug === "demo-skill")).toHaveLength(1);
    await expect(f.service.resolveCommandSkill(f.actor.user, "demo-skill")).rejects.toMatchObject({
      statusCode: 409,
    });
    for (const direct of [first.id, `${first.namespace}/${first.slug}`]) {
      await expect(f.service.resolveCommandSkill(f.actor.user, direct)).resolves.toMatchObject({
        id: first.id,
      });
    }
    expect(f.adminRpcCall).not.toHaveBeenCalled();
  });
  it.each(
    (["admin", "owner"] as const).flatMap((manager) =>
      (["PENDING_REVIEW", "SCANNING", "SCAN_FAILED"] as const).map((status) => ({
        manager,
        status,
      })),
    ),
  )(
    "installs an intact unverified $status artifact for $manager in a public room",
    async ({ manager, status }) => {
      const f = await setup(true, true, manager);
      f.adapterMocks.listVersions.mockResolvedValue([
        { id: 20, version: "1.0.0", status, downloadAvailable: true },
      ]);
      f.adapterMocks.download.mockResolvedValue(await archive());
      expect(await f.service.resolveCommandSkill(f.actor.user, "demo-skill", "room")).toMatchObject(
        { id: f.entry!.id, version: "1.0.0" },
      );
      expect(await f.run(`install ${f.entry!.id}`)).toMatchObject({
        text: expect.stringContaining("설치 완료"),
      });
      expect(f.adapterMocks.download).toHaveBeenCalled();
      expect(f.adminRpcCall).toHaveBeenCalledWith(
        "skills.install",
        expect.objectContaining({ agentId: f.agentId }),
      );
    },
  );

  it.each([false, true])(
    "executes commands through plugin dispatch, HTTP and the real catalog (room=%s)",
    async (room) => {
      const f = await setup(true, room);
      const listVersions = f.adapterMocks.listVersions.getMockImplementation()!;
      f.adapterMocks.listVersions.mockImplementation(async (namespace, slug) =>
        namespace === f.entry!.namespace && slug === f.entry!.slug
          ? [{ id: 20, version: "1.0.0", status: "PUBLISHED", downloadAvailable: true }]
          : await listVersions(namespace, slug),
      );
      f.adapterMocks.download.mockResolvedValue(await archive());
      let installed = false;
      f.adminRpcCall.mockImplementation(async (method) => {
        if (method === "skills.status") {
          return {
            skills: installed
              ? [
                  {
                    skillKey: "demo-skill",
                    source: "openclaw-workspace",
                    baseDir: "/workspace/skills/demo-skill",
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
        }
        if (method === "skills.uninstall") {
          installed = false;
        }
        return { ok: true, slug: "demo-skill" };
      });
      expect((await f.run("help")).text).toContain("SkillHub 명령어");
      expect((await f.run("help en")).text).toContain("SkillHub commands");
      expect((await f.run("list all")).text).toContain(f.entry!.id);
      expect((await f.run(`install ${f.entry!.id}`)).text).toContain("설치 완료");
      expect((await f.run("installed")).text).toContain("demo-skill");
      expect((await f.run(`update ${f.entry!.id}`)).text).toContain("설치 완료");
      expect(f.adminRpcCall).toHaveBeenCalledWith(
        "skills.install",
        expect.objectContaining({
          agentId: f.agentId,
          force: true,
          expectedSkillRevision: "sha256:1111111111111111",
        }),
      );
      await writeFile(
        path.join(f.skillDir, "SKILL.md"),
        "---\nname: demo-skill\ndescription: Demo\nversion: 1.0.0\n---\nInstructions",
      );
      const publication = await f.run("publish demo-skill");
      if (room) {
        expect(publication.isError).toBe(true);
        expect(f.governanceMocks.publishArtifact).not.toHaveBeenCalled();
      } else {
        expect(publication.text).toContain("전체공개 게시 완료");
        expect(f.governanceMocks.publishArtifact).toHaveBeenCalledWith(
          expect.objectContaining({ filename: "demo-skill-1.0.0.zip" }),
        );
        const entries = await f.store.skillHubCatalog.list();
        expect(entries).toHaveLength(2);
        expect(entries.every((entry) => entry.sharing.mode === "PUBLIC")).toBe(true);
      }
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
      expect(f.adapterMocks.deleteSkill).not.toHaveBeenCalled();
      for (const [method, params] of f.adminRpcCall.mock.calls) {
        if (["skills.status", "skills.install", "skills.uninstall"].includes(method)) {
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

  it("gives explicit unavailable and unauthenticated outcomes", async () => {
    const f = await setup(false);
    expect((await f.run("list")).text).toContain("활성화되어 있지 않습니다");
    expect((await f.run("--lang=en list")).text).toContain("Skill Hub is not enabled");
    expect((await fetch(f.endpoint, { method: "POST", body: "{}" })).status).toBe(401);
    expect(f.adapterMocks.search).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "pages every visible stable ID without including hidden entries (room=%s)",
    async (room) => {
      const f = await setup(true, room);
      for (let index = 0; index < 41; index++) {
        await f.seedEntry({ slug: `skill-${index}` });
      }
      const other = await f.createActor("other.owner");
      await f.seedEntry({
        ownerUserId: other.user.id,
        slug: "hidden-skill",
        sharing: { mode: "PRIVATE", userIds: [], scopeIds: [] },
      });
      const visible = await f.service.search(f.actor.user, "", 500, room ? "room" : "employee");
      const pages = await Promise.all(
        [1, 2, 3].map(async (page) => (await f.run(`list ${page}`)).text ?? ""),
      );
      expect(pages[0]).toContain("/skillhub list 2");
      expect(pages[1]).toContain("/skillhub list 3");
      expect(pages[2]).not.toContain("/skillhub list 4");
      const ids = pages.flatMap((text) =>
        [...text.matchAll(/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}/gu)].map(
          (match) => match[0],
        ),
      );
      expect(ids).toEqual(visible.items.map((entry) => entry.id));
      expect(f.adapterMocks.search).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "requires a stable ID when names are ambiguous (room=%s)",
    async (room) => {
      const f = await setup(true, room);
      const other = await f.seedEntry();
      for (const action of ["install", "update"]) {
        expect(await f.run(`${action} demo-skill`)).toMatchObject({
          isError: true,
          text: expect.stringContaining("Choose a skill ID"),
        });
      }
      const reply = await f.run("install demo-skill");
      expect(reply.text).toContain(f.entry!.id);
      expect(reply.text).toContain(other.id);
      expect(f.adapterMocks.download).not.toHaveBeenCalled();
      expect(f.adminRpcCall).not.toHaveBeenCalled();
    },
  );

  it.each(["PRIVATE", "SELECTED"] as const)(
    "keeps personally accessible %s skills out of room search and install",
    async (mode) => {
      const f = await setup(true, true, "admin");
      const restricted = await f.seedEntry({
        slug: "restricted",
        sharing: { mode, userIds: mode === "SELECTED" ? [f.actor.user.id] : [], scopeIds: [] },
      });
      expect((await f.run("list")).text).not.toContain(restricted.id);
      expect((await f.run(`install ${restricted.id}`)).isError).toBe(true);
      expect((await f.run("update restricted")).isError).toBe(true);
      expect(f.adapterMocks.download).not.toHaveBeenCalled();
      expect(f.adminRpcCall).not.toHaveBeenCalled();
    },
  );

  it("rechecks a real disabled DM binding after download before install commit", async () => {
    const f = await setup();
    f.adapterMocks.download.mockImplementation(async () => {
      const binding = await f.store.getPersonalAgentBinding(f.actor.user.id);
      if (!binding) {
        throw new Error("Missing fixture binding");
      }
      await f.store.transitionAgent({ bindingId: binding.id, state: "disabled", changedAt: 50 });
      return await archive();
    });
    expect((await f.run(`install ${f.entry!.id}`)).isError).toBe(true);
    expect(f.adminRpcCall).not.toHaveBeenCalledWith("skills.install", expect.anything());
  });

  it("rechecks company sharing after download before committing a room installation", async () => {
    const f = await setup(true, true);
    f.adapterMocks.download.mockImplementation(async () => {
      await f.store.skillHubCatalog.updateMetadata({
        skillId: f.entry!.id,
        actorUserId: f.actor.user.id,
        expectedRevision: f.entry!.revision,
        sharing: { mode: "PRIVATE", userIds: [], scopeIds: [] },
        now: 50,
      });
      return await archive();
    });
    expect((await f.run(`install ${f.entry!.id}`)).isError).toBe(true);
    expect(f.adminRpcCall).not.toHaveBeenCalledWith("skills.install", expect.anything());
  });

  it.each(["knowledge", "automation", "utility", "other"])(
    "explains unsupported category %s",
    async (category) => {
      const f = await setup();
      expect(await f.run(`list ${category}`)).toMatchObject({
        isError: true,
        text: expect.stringContaining("Page must be 1 to 25"),
      });
      expect(f.adapterMocks.search).not.toHaveBeenCalled();
    },
  );
});
