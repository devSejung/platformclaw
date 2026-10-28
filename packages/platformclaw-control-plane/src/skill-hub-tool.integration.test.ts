import { writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi, OpenClawPluginToolFactory } from "../../../src/plugins/types.js";
import { resolveRelativeBundledPluginPublicModuleId } from "../../../src/test-utils/bundled-plugin-public-surface.js";
import { readBrowserJsonBody } from "./browser-http-shared.js";
import { KnoxRoutingService } from "./knox-routing-service.js";
import { handlePlatformClawKnoxInternalRequest } from "./knox-skill-hub-http.js";
import type { KnoxSkillHubCommandContext } from "./skill-hub-command-workspace.js";
import { createSkillHubServiceFixture } from "./skill-hub-service.test-fixtures.js";

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

async function setup(room = true, manager?: "admin" | "owner") {
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
    roomId: "group-one",
    reservedAt: 5,
  });
  const roomBinding = reservation.binding;
  await fixture.store.transitionAgent({ bindingId: roomBinding.id, state: "active", changedAt: 6 });
  const agentId = room ? roomBinding.agentId : fixture.actor.agentId;
  const context: KnoxSkillHubCommandContext = {
    accountId: "default",
    conversationType: room ? "room" : "dm",
    conversationId: room ? roomBinding.roomId : "personal-chat",
    agentId,
    sessionKey: `agent:${agentId}:main`,
  };
  if (!fixture.entry) {
    throw new Error("Missing default catalog entry");
  }
  await fixture.service.updateMetadata(fixture.actor.user, fixture.entry.id, {
    expectedRevision: fixture.entry.revision,
    summary: "Synthetic task helper",
  });
  const candidate = (await fixture.service.search(fixture.actor.user, "task helper")).items[0]!;
  fixture.adapterMocks.listVersions.mockResolvedValue([
    { id: 1, version: "1.0.0", status: "PUBLISHED", downloadAvailable: true },
  ]);
  const zip = new JSZip();
  zip.file(
    "SKILL.md",
    "---\nname: demo-skill\ndescription: Synthetic helper\nversion: 1.0.0\n---\nInstructions",
  );
  fixture.adapterMocks.download.mockResolvedValue(
    await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
  );
  const ready = {
    skillKey: "demo-skill",
    source: "openclaw-workspace",
    baseDir: "/workspace/skills/demo-skill",
    version: "1.0.0",
    revision: "sha256:1111111111111111",
    eligible: true,
    disabled: false,
    modelVisible: true,
    missing: { bins: [], anyBins: [], env: [], config: [], os: [] },
  };
  let installed = false;
  fixture.adminRpcCall.mockImplementation(async (method: string) => {
    if (method === "skills.status") {
      return { skills: installed ? [ready] : [] };
    }
    if (method === "skills.upload.begin") {
      return { uploadId: "synthetic-upload", receivedBytes: 0 };
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
  const serviceToken = "synthetic-service-token-".repeat(3);
  const server = createServer((req, res) => {
    void handlePlatformClawKnoxInternalRequest(req, res, {
      service: new KnoxRoutingService({
        store: fixture.store,
        roomProvisioner: { provision: async () => undefined },
        buildAgentMainSessionKey: ({ agentId: bindingAgentId }) => `agent:${bindingAgentId}:main`,
      }),
      skillHubService: fixture.service,
      serviceToken,
      readJsonBody: readBrowserJsonBody,
    }).catch(() => {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: "synthetic-operation-error" }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("missing synthetic server address");
  }
  const endpoint = `http://127.0.0.1:${address.port}/platformclaw/internal/knox/skillhub`;
  const tokenFile = path.join(fixture.workspaceRoot, "synthetic-service-token");
  await writeFile(tokenFile, serviceToken);
  vi.stubEnv("PLATFORMCLAW_KNOX_SERVICE_TOKEN_FILE", tokenFile);
  vi.stubEnv("PLATFORMCLAW_KNOX_CONTROL_PLANE_URL", endpoint);
  const factories = new Map<string, OpenClawPluginToolFactory>();
  skillHubPlugin.register({
    registrationMode: "tool-discovery",
    registerTool: (factory, options) => {
      if (typeof factory !== "function" || !options?.name) {
        throw new Error("expected a named SkillHub tool factory");
      }
      factories.set(options.name, factory);
    },
  } as OpenClawPluginApi);
  const tool = (action: "search" | "status" | "install" | "delete") => {
    const current = factories.get(`skillhub_${action}`)?.({
      config: {},
      agentId,
      sessionKey: context.sessionKey,
      requesterSenderId: "person.one",
      messageChannel: "knox",
      agentAccountId: "default",
      nativeChannelId: context.conversationId,
      deliveryContext: {
        channel: "knox",
        accountId: "default",
        to: `${context.conversationType}:${context.conversationId}`,
      },
    });
    if (!current || Array.isArray(current)) {
      throw new Error("missing single SkillHub tool");
    }
    return current;
  };
  const call = async (
    action: string,
    input: Record<string, unknown>,
    overrides: Partial<KnoxSkillHubCommandContext> = {},
    sender = "person.one",
  ) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${serviceToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        accountId: sender,
        action,
        input,
        context: { ...context, ...overrides },
      }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const markOrigin = async (
    destination: "platform_server" | "assigned_vm" = "platform_server",
    skillId = candidate.id,
  ) => {
    const origin = {
      operationId: "preexisting-" + destination,
      agentId,
      destination,
      targetId:
        destination === "assigned_vm"
          ? (await fixture.store.resolvePersonalExecutionTarget(agentId, "assigned_vm")).targetId
          : "platform-server",
      slug: "demo-skill",
      skillId,
      version: "1.0.0",
      archiveSha256: "a".repeat(64),
      installedRevision: ready.revision,
      installedAt: 20,
    };
    await fixture.store.skillHubCatalog.recordInstallation({ ...origin, state: "pending" });
    await fixture.store.skillHubCatalog.completeInstallation({ ...origin, now: 21 });
  };
  const installInput = { id: fixture.entry.id, version: "1.0.0" };
  return {
    ...fixture,
    context,
    candidate,
    ready,
    call,
    tool,
    installInput,
    roomBinding,
    markOrigin,
  };
}

async function activateVm(fixture: Awaited<ReturnType<typeof createSkillHubServiceFixture>>) {
  return await fixture.activateVm((await fixture.saveVm()).id);
}

describe("Knox Skill Hub natural-language tool transport", () => {
  it.each(
    (["admin", "owner"] as const).flatMap((manager) =>
      (["PENDING_REVIEW", "SCANNING", "SCAN_FAILED"] as const).map((status) => ({
        manager,
        status,
      })),
    ),
  )(
    "installs intact unverified $status artifacts for $manager in a public room",
    async ({ manager, status }) => {
      const f = await setup(true, manager);
      f.adapterMocks.listVersions.mockResolvedValue([
        { id: 20, version: "1.0.0", status, downloadAvailable: true },
      ]);
      f.adapterMocks.getVersionState.mockResolvedValue({ id: 20, version: "1.0.0", status });
      expect((await f.call("install", f.installInput)).status).toBe(200);
      expect(
        await f.tool("install").execute("unverified-room-install", f.installInput),
      ).toMatchObject({ details: { ok: true, noOp: true } });
      expect(f.adapterMocks.download).toHaveBeenCalled();
      expect(f.adminRpcCall).toHaveBeenCalledWith(
        "skills.install",
        expect.objectContaining({ agentId: f.context.agentId }),
      );
    },
  );

  it.each(
    (["admin", "owner"] as const).flatMap((manager) =>
      [
        { room: true, status: "PUBLISHED" },
        { room: false, status: "PUBLISHED" },
      ].map((scenario) => ({ manager, room: scenario.room, status: scenario.status })),
    ),
  )("allows $manager $status installation (room=$room)", async ({ manager, room, status }) => {
    const f = await setup(room, manager);
    f.adapterMocks.listVersions.mockResolvedValue([
      { id: 20, version: "1.0.0", status, downloadAvailable: true },
    ]);
    f.adapterMocks.getVersionState.mockResolvedValue({ id: 20, version: "1.0.0", status });
    expect(await f.tool("install").execute("permitted-install", f.installInput)).toMatchObject({
      details: { ok: true, noOp: false, version: "1.0.0" },
    });
    expect(f.adapterMocks.download).toHaveBeenCalledWith(f.entry!.namespace, "demo-skill", "1.0.0");
    expect(f.adminRpcCall).toHaveBeenCalledWith(
      "skills.install",
      expect.objectContaining({ agentId: f.context.agentId }),
    );
  });

  it.each([true, false])(
    "executes plugin tools through HTTP and reports next-run readiness (room=%s)",
    async (room) => {
      const f = await setup(room);
      expect(await f.tool("search").execute("search-turn", { query: "task helper" })).toMatchObject(
        {
          details: {
            agentId: f.context.agentId,
            audience: room ? "room" : "employee",
            target: "platform_server",
            items: [f.candidate],
          },
        },
      );
      expect(await f.tool("install").execute("approval-turn", f.installInput)).toMatchObject({
        details: { ok: true, noOp: false, version: "1.0.0" },
      });
      expect(f.adapterMocks.download).toHaveBeenCalledWith(
        f.entry!.namespace,
        "demo-skill",
        "1.0.0",
      );
      expect(f.adminRpcCall).toHaveBeenCalledWith("skills.install", {
        agentId: f.context.agentId,
        source: "upload",
        uploadId: "synthetic-upload",
        slug: "demo-skill",
        force: false,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        destination: "sandbox-backend",
        ...(room ? {} : { backendTarget: "platform_server" }),
        expectedTargetRevision: 0,
      });
      expect(await f.tool("status").execute("next-turn", { slug: "demo-skill" })).toMatchObject({
        details: {
          items: [{ skillKey: "demo-skill", eligible: true, modelVisible: true }],
          total: 1,
          truncated: false,
        },
      });
      expect(await f.tool("install").execute("webhook-redelivery", f.installInput)).toMatchObject({
        details: { ok: true, noOp: true },
      });
      expect(
        f.adminRpcCall.mock.calls.filter(([method]) => method === "skills.install"),
      ).toHaveLength(1);
    },
  );

  it("returns only room-public candidates even when the sender has private grants", async () => {
    const f = await setup();
    await f.seedEntry({
      slug: "private-helper",
      sharing: { mode: "PRIVATE", userIds: [], scopeIds: [] },
    });
    await f.seedEntry({
      slug: "selected-helper",
      sharing: { mode: "SELECTED", userIds: [f.actor.user.id], scopeIds: [] },
    });
    expect(await f.call("search", { query: "" })).toMatchObject({
      status: 200,
      body: { items: [f.candidate], total: 1 },
    });
  });

  it("bounds search output even when the registry exceeds its requested limit", async () => {
    const f = await setup();
    for (let index = 0; index < 7; index++) {
      const entry = await f.seedEntry({ slug: "helper-" + index });
      await f.service.updateMetadata(f.actor.user, entry.id, {
        expectedRevision: entry.revision,
        summary: "s".repeat(500),
      });
    }
    const result = await f.call("search", { query: "helper" });
    expect(result.status).toBe(200);
    expect(result.body.items).toHaveLength(5);
    expect(result.body.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ summary: "s".repeat(160) })]),
    );
  });

  it.each([true, false])(
    "deletes the installed skill through plugin HTTP transport and keeps the registry original (room=%s)",
    async (room) => {
      const f = await setup(room);
      await f.tool("install").execute("install-turn", f.installInput);
      expect(
        await f.tool("delete").execute("delete-turn", { slug: "demo-skill", confirm: true }),
      ).toMatchObject({
        details: { ok: true, slug: "demo-skill", version: "1.0.0", target: "platform_server" },
      });
      expect(f.adminRpcCall).toHaveBeenCalledWith("skills.uninstall", {
        agentId: f.context.agentId,
        slug: "demo-skill",
        destination: "sandbox-backend",
        ...(room ? {} : { backendTarget: "platform_server" }),
        expectedTargetRevision: 0,
        expectedSkillRevision: f.ready.revision,
      });
      expect(await f.tool("status").execute("status-turn", { slug: "demo-skill" })).toMatchObject({
        details: { items: [], total: 0 },
      });
      expect(await f.tool("search").execute("search-turn", { query: "helper" })).toMatchObject({
        details: { items: [f.candidate] },
      });
      expect(f.adapterMocks.deleteSkill).not.toHaveBeenCalled();
      expect(
        f.adminRpcCall.mock.calls.filter(([method]) => method === "skills.uninstall"),
      ).toHaveLength(1);
    },
  );

  it("deletes only the active VM copy and preserves the Basic copy of the same slug", async () => {
    const f = await setup(false);
    const target = await activateVm(f);
    const vmSkill = {
      ...f.ready,
      source: "platformclaw-vm-workspace",
      revision: "sha256:2222222222222222",
    };
    let vmInstalled = true;
    f.adminRpcCall.mockImplementation(async (method: string) => {
      if (method === "skills.status") {
        return { skills: vmInstalled ? [f.ready, vmSkill] : [f.ready] };
      }
      if (method === "skills.uninstall") {
        vmInstalled = false;
        return { ok: true, slug: "demo-skill" };
      }
      throw new Error("unexpected deletion RPC");
    });
    expect(
      await f.tool("delete").execute("delete-turn", { slug: "demo-skill", confirm: true }),
    ).toMatchObject({
      details: { ok: true, target: "assigned_vm" },
    });
    expect(f.adminRpcCall).toHaveBeenCalledWith("skills.uninstall", {
      agentId: f.actor.agentId,
      slug: "demo-skill",
      destination: "sandbox-backend",
      backendTarget: "assigned_vm",
      expectedTargetRevision: target.revision,
      expectedSkillRevision: vmSkill.revision,
    });
    expect(await f.call("status", { slug: "demo-skill" })).toMatchObject({
      status: 200,
      body: { target: "assigned_vm", items: [], total: 0 },
    });
    await f.store.changePersonalExecutionTarget({
      agentId: f.actor.agentId,
      target: "platform_server",
      expectedRevision: target.revision,
      changedAt: 10,
    });
    expect(await f.call("status", { slug: "demo-skill" })).toMatchObject({
      status: 200,
      body: { target: "platform_server", items: [{ revision: f.ready.revision }], total: 1 },
    });
    expect(f.adapterMocks.deleteSkill).not.toHaveBeenCalled();
    expect(f.adapterMocks.search).not.toHaveBeenCalled();
  });

  it.each([
    { slug: "demo-skill" },
    { slug: "demo-skill", confirm: false },
    { slug: "demo-skill", confirm: "true" },
    { slug: "demo-skill", confirm: 1 },
    { confirm: true },
    { slug: "demo-skill", confirm: true, namespace: "engineering" },
  ])("requires an explicit true confirmation and only delete fields %j", async (input) => {
    const f = await setup();
    expect((await f.call("delete", input)).status).toBe(400);
    expect(f.adminRpcCall).not.toHaveBeenCalled();
    expect(f.adapterMocks.deleteSkill).not.toHaveBeenCalled();
  });

  it.each(["engineering/demo-skill", "../demo-skill", "/tmp/demo-skill", "skills\\demo-skill"])(
    "rejects a deletion path instead of an installed slug: %s",
    async (slug) => {
      const f = await setup();
      expect((await f.call("delete", { slug, confirm: true })).status).toBe(400);
      expect(f.adminRpcCall).not.toHaveBeenCalled();
      expect(f.adapterMocks.deleteSkill).not.toHaveBeenCalled();
    },
  );

  it("does not delete a skill found only on another installed source", async () => {
    const f = await setup();
    f.adminRpcCall.mockResolvedValue({
      skills: [{ ...f.ready, source: "platformclaw-vm-workspace" }],
    });
    expect((await f.call("delete", { slug: "demo-skill", confirm: true })).status).toBe(404);
    expect(f.adminRpcCall.mock.calls.map(([method]) => method)).toEqual(["skills.status"]);
    expect(f.adapterMocks.deleteSkill).not.toHaveBeenCalled();
  });

  it.each([
    { eligible: true, disabled: false },
    { eligible: false, disabled: true },
    {
      eligible: false,
      disabled: false,
      missing: { bins: [], anyBins: [], env: ["SYNTHETIC_TOKEN"], config: [], os: [] },
    },
  ])("reports an existing skill's readiness without reinstalling %j", async (readiness) => {
    const f = await setup();
    await f.markOrigin();
    f.adminRpcCall.mockResolvedValue({ skills: [{ ...f.ready, ...readiness }] });
    expect(await f.call("install", f.installInput)).toMatchObject({
      status: 200,
      body: { ok: true, noOp: true, readiness },
    });
    expect(f.adapterMocks.download).not.toHaveBeenCalled();
    expect(f.adminRpcCall.mock.calls.map(([method]) => method)).toEqual(["skills.status"]);
  });

  it.each([
    { accountId: "other-relay" },
    { conversationId: "other-room" },
    { sessionKey: "agent:other-agent:main" },
  ])("rejects an unrelated room/session %j", async (overrides) => {
    const f = await setup();
    expect((await f.call("install", f.installInput, overrides)).status).toBe(409);
    expect((await f.call("delete", { slug: "demo-skill", confirm: true }, overrides)).status).toBe(
      409,
    );
    expect(f.adapterMocks.download).not.toHaveBeenCalled();
    expect(f.adminRpcCall).not.toHaveBeenCalled();
  });

  it("rejects unlinked and disabled senders before reading the registry", async () => {
    const f = await setup();
    expect((await f.call("install", f.installInput, {}, "unlinked.person")).status).toBe(401);
    const admin = await f.createActor("admin.user");
    await f.store.setManagedUserStatus({
      actorUserId: admin.user.id,
      targetUserId: f.actor.user.id,
      status: "disabled",
      changedAt: 50,
    });
    expect((await f.call("search", { query: "helper" })).status).toBe(401);
    expect(f.adapterMocks.search).not.toHaveBeenCalled();
  });

  it("rejects an inactive room binding before registry access", async () => {
    const f = await setup();
    await f.store.transitionAgent({
      bindingId: f.roomBinding.id,
      state: "disabled",
      changedAt: 50,
    });
    expect((await f.call("install", f.installInput)).status).toBe(409);
    expect(f.adapterMocks.search).not.toHaveBeenCalled();
    expect(f.adminRpcCall).not.toHaveBeenCalled();
  });

  it("uses the personal active VM and its skill source for status and existing installs", async () => {
    const f = await setup(false);
    await activateVm(f);
    await f.markOrigin("assigned_vm");
    f.adminRpcCall.mockResolvedValue({
      skills: [{ ...f.ready, source: "platformclaw-vm-workspace" }],
    });
    expect(await f.call("search", { query: "helper" })).toMatchObject({
      status: 200,
      body: { target: "assigned_vm", audience: "employee", agentId: f.actor.agentId },
    });
    expect(await f.call("install", f.installInput)).toMatchObject({
      status: 200,
      body: { target: "assigned_vm", noOp: true, readiness: { eligible: true } },
    });
    expect(f.adminRpcCall).toHaveBeenCalledWith("skills.status", {
      agentId: f.actor.agentId,
      refresh: true,
      backendTarget: "assigned_vm",
    });
    expect(f.adapterMocks.download).not.toHaveBeenCalled();
  });

  it("does not report another VM's same-name copy as installed after an awaited catalog lookup", async () => {
    const f = await setup(false);
    const first = await f.saveVm();
    const second = await f.saveVm();
    await f.activateVm(first.id);
    await f.markOrigin("assigned_vm");
    f.adminRpcCall.mockResolvedValue({
      skills: [{ ...f.ready, source: "platformclaw-vm-workspace" }],
    });
    f.adapterMocks.listVersions.mockImplementationOnce(async () => {
      await f.activateVm(second.id);
      return [{ id: 1, version: "1.0.0", status: "PUBLISHED", downloadAvailable: true }];
    });
    expect(await f.call("install", f.installInput)).toMatchObject({
      status: 409,
      body: { error: "Skill Hub execution target changed; check status and retry." },
    });
    expect(f.adapterMocks.download).not.toHaveBeenCalled();
    expect(f.adminRpcCall).not.toHaveBeenCalledWith("skills.install", expect.anything());
    expect(await f.store.skillHubCatalog.listInstallations(f.actor.agentId, second.id)).toEqual([]);
  });

  it("rejects a Basic-to-VM switch after status and before upload", async () => {
    const f = await setup(false);
    f.adapterMocks.listVersions.mockImplementation(async () => {
      f.getPersonalExecutionProfile.mockResolvedValue({
        agentBindingId: "binding-1",
        activeTarget: "assigned_vm",
        activeAllocationId: "allocation-1",
        targetRevision: 7,
        updatedAt: 1,
      });
      return [{ id: 1, version: "1.0.0", status: "PUBLISHED", downloadAvailable: true }];
    });
    expect(await f.call("install", f.installInput)).toMatchObject({
      status: 409,
      body: { error: "Skill Hub execution target changed; check status and retry." },
    });
    expect(f.adapterMocks.download).not.toHaveBeenCalled();
    expect(f.adminRpcCall).not.toHaveBeenCalledWith("skills.upload.begin", expect.anything());
  });

  it("installs into Basic when the same slug exists only in the VM source", async () => {
    const f = await setup(false);
    f.getPersonalExecutionProfile.mockResolvedValue({
      agentBindingId: "binding-1",
      activeTarget: "platform_server",
      targetRevision: 9,
      updatedAt: 1,
    });
    let installed = false;
    f.adminRpcCall.mockImplementation(async (method: string) => {
      if (method === "skills.status") {
        return {
          skills: [
            ...(installed ? [f.ready] : []),
            { ...f.ready, source: "platformclaw-vm-workspace" },
            {
              ...f.ready,
              skillKey: "other-basic-helper",
              baseDir: "/workspace/skills/other-basic-helper",
            },
          ],
        };
      }
      if (method === "skills.upload.begin") {
        return { uploadId: "synthetic-upload", receivedBytes: 0 };
      }
      if (method === "skills.install") {
        installed = true;
      }
      return { ok: true, slug: "demo-skill" };
    });
    expect(await f.call("install", f.installInput)).toMatchObject({
      status: 200,
      body: { ok: true, noOp: false, target: "platform_server" },
    });
    expect(f.adminRpcCall).toHaveBeenCalledWith(
      "skills.install",
      expect.objectContaining({
        agentId: f.actor.agentId,
        backendTarget: "platform_server",
        expectedTargetRevision: 9,
        force: false,
      }),
    );
  });

  it.each(["absent", "download-unavailable"])(
    "rejects a recommendation that is %s without starting upload",
    async (state) => {
      const f = await setup();
      if (state === "absent") {
        await f.store.skillHubCatalog.trash({
          skillId: f.candidate.id,
          actorUserId: f.actor.user.id,
          expectedRevision: f.candidate.revision,
          now: 50,
        });
      } else {
        f.governanceMocks.getArtifactSecurity.mockResolvedValue({
          audits: [],
          artifactAvailable: false,
          blocked: false,
        });
      }
      expect((await f.call("install", f.installInput)).status).toBe(state === "absent" ? 404 : 409);
      expect(f.adapterMocks.download).not.toHaveBeenCalled();
      expect(f.adminRpcCall).not.toHaveBeenCalledWith("skills.upload.begin", expect.anything());
    },
  );

  it("bounds status output and can inspect a skill beyond the first page", async () => {
    const f = await setup();
    f.adminRpcCall.mockResolvedValue({
      skills: Array.from({ length: 11 }, (_, index) => ({
        ...f.ready,
        skillKey: `helper-${index}`,
        baseDir: `/workspace/skills/helper-${index}`,
        description: "d".repeat(500),
      })),
    });
    const list = await f.call("status", {});
    expect(list).toMatchObject({ status: 200, body: { total: 11, truncated: true } });
    expect(list.body.items).toHaveLength(10);
    expect(await f.call("status", { slug: "helper-10" })).toMatchObject({
      status: 200,
      body: {
        total: 1,
        truncated: false,
        items: [{ skillKey: "helper-10", description: "d".repeat(160) }],
      },
    });
  });

  it("rejects a changed recommended version and does not select the new latest version", async () => {
    const f = await setup();
    f.adapterMocks.listVersions.mockResolvedValue([
      { id: 21, version: "2.0.0", status: "PUBLISHED", downloadAvailable: true },
    ]);
    expect((await f.call("install", f.installInput)).status).toBe(409);
    expect(f.adapterMocks.download).not.toHaveBeenCalled();
    expect(f.adminRpcCall).not.toHaveBeenCalledWith("skills.upload.begin", expect.anything());
    expect(f.adminRpcCall).not.toHaveBeenCalledWith("skills.install", expect.anything());
  });

  it("does not expose force/replacement parameters to the natural-language tool", async () => {
    const f = await setup();
    expect((await f.call("install", { ...f.installInput, force: true })).status).toBe(400);
    expect(f.adminRpcCall).not.toHaveBeenCalled();
  });

  it.each([
    ["search", { slug: "demo-skill" }],
    ["status", { query: "helper" }],
    ["search", { query: "q".repeat(1001) }],
    ["install", { namespace: "engineering", slug: "demo-skill" }],
    ["install", { id: " ", version: "1.0.0" }],
    ["install", { id: "n".repeat(129), version: "1.0.0" }],
  ])(
    "rejects invalid %s action fields %j before registry or Gateway calls",
    async (action, input) => {
      const f = await setup();
      expect((await f.call(action as string, input as Record<string, unknown>)).status).toBe(400);
      expect(f.adapterMocks.search).not.toHaveBeenCalled();
      expect(f.adminRpcCall).not.toHaveBeenCalled();
    },
  );

  it("installs once for concurrent requests and observes the installed skill on redelivery", async () => {
    const f = await setup();
    const replies = await Promise.all([
      f.call("install", f.installInput),
      f.call("install", f.installInput),
    ]);
    expect(replies.every((reply) => reply.status === 200)).toBe(true);
    expect(await f.call("install", f.installInput)).toMatchObject({
      status: 200,
      body: { noOp: true },
    });
    expect(
      f.adminRpcCall.mock.calls.filter(([method]) => method === "skills.install"),
    ).toHaveLength(1);
  });

  it("keeps an uncertain installation visible and requires explicit replacement before retrying", async () => {
    const f = await setup();
    vi.spyOn(f.store.skillHubCatalog, "completeInstallation").mockRejectedValueOnce(
      new Error("synthetic response loss after install"),
    );
    expect((await f.call("install", f.installInput)).status).toBe(500);
    expect(await f.call("install", f.installInput)).toMatchObject({ status: 409 });
    expect(
      f.adminRpcCall.mock.calls.filter(([method]) => method === "skills.install"),
    ).toHaveLength(1);
    expect(
      await f.store.skillHubCatalog.listInstallations(f.context.agentId, "platform-server"),
    ).toEqual([expect.objectContaining({ state: "pending", skillId: f.candidate.id })]);
    const actor = {
      ...f.actor,
      agentId: f.context.agentId,
      workspaceDir: path.join(f.workspaceRoot, f.context.agentId),
      roomBinding: f.roomBinding,
    };
    await expect(
      f.service.install(actor, {
        ...f.installInput,
        destination: "platform_server",
        acknowledgedReplacement: true,
        currentRevision: f.ready.revision,
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(
      f.adminRpcCall.mock.calls.filter(([method]) => method === "skills.install"),
    ).toHaveLength(2);
    expect(
      await f.store.skillHubCatalog.listInstallations(f.context.agentId, "platform-server"),
    ).toEqual([expect.objectContaining({ state: "completed", skillId: f.candidate.id })]);
  });

  it("does not claim that another Hub ID with the same package name is installed", async () => {
    const f = await setup();
    await f.tool("install").execute("install-original", f.installInput);
    const other = await f.seedEntry();
    const result = await f.call("install", { id: other.id, version: "1.0.0" });
    expect(result).toMatchObject({
      status: 409,
      body: { details: { code: "existing-skill-replacement-required" } },
    });
    expect(
      f.adminRpcCall.mock.calls.filter(([method]) => method === "skills.install"),
    ).toHaveLength(1);
  });
});
