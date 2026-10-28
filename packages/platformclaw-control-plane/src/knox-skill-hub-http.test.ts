import { createServer, type Server } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readBrowserJsonBody } from "./browser-http-shared.js";
import { KnoxRoutingService } from "./knox-routing-service.js";
import { handlePlatformClawKnoxInternalRequest } from "./knox-skill-hub-http.js";
import { createSkillHubServiceFixture } from "./skill-hub-service.test-fixtures.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }),
  );
});
const policyPath = "/platformclaw/api/internal/skill-hub/room-skills";
const commandPath = "/platformclaw/internal/knox/skillhub";

async function fixture(enabled = true) {
  const f = await createSkillHubServiceFixture();
  const reservation = await f.store.reserveKnoxRoomAgent({
    accountId: "default",
    roomId: "room-one",
    reservedAt: 5,
  });
  const room = reservation.binding;
  await f.store.transitionAgent({ bindingId: room.id, state: "active", changedAt: 6 });
  const routing = new KnoxRoutingService({
    store: f.store,
    roomProvisioner: { provision: async () => undefined },
    buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
  });
  const readJsonBody = vi.fn(readBrowserJsonBody);
  const serviceToken = "synthetic-service-token-for-policy-test";
  const server = createServer((request, response) => {
    void handlePlatformClawKnoxInternalRequest(request, response, {
      service: routing,
      skillHubService: enabled ? f.service : undefined,
      serviceToken,
      readJsonBody,
    })
      .then((handled) => {
        if (!handled) {
          response.writeHead(404).end();
        }
      })
      .catch(() =>
        response.writeHead(500).end(JSON.stringify({ error: "unexpected-test-failure" })),
      );
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing test server address");
  }
  const request = async (
    body: unknown,
    options: { path?: string; method?: string; token?: string | null; raw?: string } = {},
  ) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${options.path ?? policyPath}`, {
      method: options.method ?? "POST",
      headers: {
        "Content-Type": "application/json",
        ...(options.token === null
          ? {}
          : { Authorization: `Bearer ${options.token ?? serviceToken}` }),
      },
      ...(options.method === "GET" ? {} : { body: options.raw ?? JSON.stringify(body) }),
    });
    return {
      status: response.status,
      headers: response.headers,
      body: (await response.json()) as Record<string, unknown>,
    };
  };
  const candidate = {
    name: "Demo skill",
    filePath: path.join(f.workspaceRoot, room.agentId, "skills", "demo-skill", "SKILL.md"),
  };
  const origin = {
    operationId: "room-installation",
    agentId: room.agentId,
    destination: "platform_server" as const,
    targetId: "platform-server",
    slug: "demo-skill",
    skillId: f.entry!.id,
    version: "1.0.0",
    archiveSha256: "a".repeat(64),
    installedRevision: "sha256:1111111111111111",
    installedAt: 10,
  };
  const recordOrigin = async () => {
    await f.store.skillHubCatalog.recordInstallation({ ...origin, state: "pending" });
    await f.store.skillHubCatalog.completeInstallation({ ...origin, now: 11 });
  };
  return { ...f, room, request, readJsonBody, candidate, recordOrigin };
}

describe("Skill Hub internal HTTP boundaries", () => {
  it.each(["en", "ko"] as const)(
    "preserves a linked-account 401 and its diagnostic in %s",
    async (locale) => {
      const f = await fixture();
      const context = {
        accountId: "default",
        conversationType: "dm",
        conversationId: "42",
        agentId: f.actor.agentId,
        sessionKey: `agent:${f.actor.agentId}:main`,
      };
      const result = await f.request(
        { accountId: "unknown.employee", args: "list", locale, context },
        { path: commandPath },
      );
      expect(result.status).toBe(401);
      expect(result.body.error).toContain("linked active employee account required");
      if (locale === "ko") {
        expect(result.body.error).toContain("웹에서 로그인");
        expect(result.body.details).toEqual({
          diagnostic: "linked active employee account required",
        });
      } else {
        expect(result.body.error).toBe("linked active employee account required");
        expect(result.body).not.toHaveProperty("details");
      }
      expect(f.governanceMocks.publishArtifact).not.toHaveBeenCalled();
    },
  );

  it("keeps edited private Hub room content restricted after presentation identity is removed", async () => {
    const f = await fixture();
    await f.recordOrigin();
    await f.store.skillHubCatalog.updateMetadata({
      skillId: f.entry!.id,
      actorUserId: f.actor.user.id,
      expectedRevision: f.entry!.revision,
      sharing: { mode: "PRIVATE", userIds: [], scopeIds: [] },
      now: 20,
    });
    f.installed.set(`${f.room.agentId}/platform-server`, {
      slug: "demo-skill",
      version: "9.0.0",
      revision: "sha256:aaaaaaaaaaaaaaaa",
    });
    const context = {
      accountId: "default",
      conversationType: "room",
      conversationId: "room-one",
      agentId: f.room.agentId,
      sessionKey: `agent:${f.room.agentId}:main`,
    };
    const status = await f.request(
      { accountId: f.actor.user.accountId, action: "status", input: {}, context },
      { path: commandPath },
    );
    expect(status.status).toBe(200);
    expect(status.body.items).toEqual([expect.not.objectContaining({ hubSkillId: f.entry!.id })]);
    expect(await f.request({ agentId: f.room.agentId, candidates: [f.candidate] })).toMatchObject({
      status: 200,
      body: {
        excludedPaths: [f.candidate.filePath],
        excludedSourceDirectories: [path.dirname(f.candidate.filePath)],
      },
    });
    expect(
      await f.store.skillHubCatalog.listInstallations(f.room.agentId, "platform-server"),
    ).toHaveLength(1);
  });

  it.each([null, "incorrect-token"])(
    "requires service authority before reading request content (%s)",
    async (token) => {
      const f = await fixture();
      expect((await f.request({}, { token })).status).toBe(401);
      expect(f.readJsonBody).not.toHaveBeenCalled();
      expect(f.adapterMocks.listVersions).not.toHaveBeenCalled();
    },
  );

  it("allows only POST on the room policy endpoint", async () => {
    const f = await fixture();
    const response = await f.request({}, { method: "GET" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(f.readJsonBody).not.toHaveBeenCalled();
  });

  it.each([
    { agentId: "", candidates: [] },
    { agentId: "room", candidates: {} },
    {
      agentId: "room",
      candidates: Array.from({ length: 2001 }, () => ({
        name: "skill",
        filePath: "/skills/skill/SKILL.md",
      })),
    },
    { agentId: "room", candidates: [{ name: "skill", filePath: "bad\0path" }] },
    { agentId: "room", candidates: [{ name: "n".repeat(513), filePath: "/skill" }] },
    { agentId: "room", candidates: [{ name: "skill", filePath: "p".repeat(4097) }] },
    {
      agentId: "room",
      candidates: [{ name: "skill", filePath: "/skill", sourceFilePath: "bad\0path" }],
    },
    {
      agentId: "room",
      candidates: [{ name: "skill", filePath: "/skill", sourceFilePath: "p".repeat(4097) }],
    },
  ])("rejects malformed or unbounded run candidates before catalog access", async (body) => {
    const f = await fixture();
    expect((await f.request(body)).status).toBe(400);
    expect(f.adapterMocks.listVersions).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON and oversized request bodies", async () => {
    const f = await fixture();
    expect((await f.request({}, { raw: "{" })).status).toBe(400);
    expect(
      (await f.request({}, { raw: JSON.stringify({ padding: "x".repeat(1024 * 1024) }) })).status,
    ).toBe(400);
  });

  it("keeps personal workspaces available when Hub is disabled and closes room and unknown policy checks", async () => {
    const f = await fixture(false);
    expect(await f.request({ agentId: f.actor.agentId, candidates: [f.candidate] })).toMatchObject({
      status: 200,
      body: { excludedPaths: [] },
    });
    for (const agentId of [f.room.agentId, "unknown-agent"]) {
      expect((await f.request({ agentId, candidates: [f.candidate] })).status).toBe(503);
    }
    expect((await f.request({}, { path: commandPath })).status).toBe(503);
  });

  it("rechecks sharing and deletion for saved room copies on every run", async () => {
    const f = await fixture();
    await f.recordOrigin();
    const run = () =>
      f.request({
        agentId: f.room.agentId,
        candidates: [f.candidate, { name: "Local", filePath: "/workspace/skills/local/SKILL.md" }],
      });
    expect(await run()).toMatchObject({ status: 200, body: { excludedPaths: [] } });
    const restricted = await f.store.skillHubCatalog.updateMetadata({
      skillId: f.entry!.id,
      actorUserId: f.actor.user.id,
      expectedRevision: f.entry!.revision,
      sharing: { mode: "PRIVATE", userIds: [], scopeIds: [] },
      now: 20,
    });
    expect(await run()).toMatchObject({
      status: 200,
      body: { excludedPaths: [f.candidate.filePath] },
    });
    const publicAgain = await f.store.skillHubCatalog.updateMetadata({
      skillId: restricted.id,
      actorUserId: f.actor.user.id,
      expectedRevision: restricted.revision,
      sharing: { mode: "PUBLIC", userIds: [], scopeIds: [] },
      now: 21,
    });
    expect(await run()).toMatchObject({ status: 200, body: { excludedPaths: [] } });
    await f.store.skillHubCatalog.trash({
      skillId: publicAgain.id,
      actorUserId: f.actor.user.id,
      expectedRevision: publicAgain.revision,
      now: 22,
    });
    expect(await run()).toMatchObject({
      status: 200,
      body: { excludedPaths: [f.candidate.filePath] },
    });
  });

  it("blocks confirmed malicious installed versions through scanner outages", async () => {
    const f = await fixture();
    await f.recordOrigin();
    await f.store.skillHubCatalog.blockVersion({
      skillId: f.entry!.id,
      version: "1.0.0",
      reason: "Confirmed malicious hash",
      now: 20,
    });
    f.adapterMocks.listVersions.mockRejectedValue(new Error("Scanner unavailable"));
    expect(await f.request({ agentId: f.room.agentId, candidates: [f.candidate] })).toMatchObject({
      status: 200,
      body: { excludedPaths: [f.candidate.filePath] },
    });
  });

  it("matches only this room's installed source identity across host and remapped candidates", async () => {
    const f = await fixture();
    await f.recordOrigin();
    await f.store.skillHubCatalog.updateMetadata({
      skillId: f.entry!.id,
      actorUserId: f.actor.user.id,
      expectedRevision: f.entry!.revision,
      sharing: { mode: "PRIVATE", userIds: [], scopeIds: [] },
      now: 20,
    });
    const roomWorkspace = path.join(f.workspaceRoot, f.room.agentId);
    const remapped = {
      name: "demo-skill",
      filePath: "/sandbox/skills/demo-skill-2/SKILL.md",
      sourceFilePath: f.candidate.filePath,
    };
    const unrelated = [
      {
        name: "project-demo",
        filePath: path.join(roomWorkspace, ".agents", "skills", "demo-skill", "SKILL.md"),
      },
      {
        name: "grouped-demo",
        filePath: path.join(roomWorkspace, "skills", "team", "demo-skill", "SKILL.md"),
      },
      { name: "bundled-demo", filePath: "/opt/bundled/demo-skill/SKILL.md" },
      { name: "node-demo", filePath: "node://other-node/skills/demo-skill/SKILL.md" },
      {
        name: "other-agent-demo",
        filePath: path.join(f.workspaceRoot, f.actor.agentId, "skills", "demo-skill", "SKILL.md"),
      },
      {
        name: "materialized-local",
        filePath: "/sandbox/skills/demo-skill/SKILL.md",
        sourceFilePath: path.join(roomWorkspace, ".agents", "skills", "demo-skill", "SKILL.md"),
      },
    ];
    expect(
      await f.request({
        agentId: f.room.agentId,
        candidates: [f.candidate, remapped, ...unrelated],
      }),
    ).toMatchObject({
      status: 200,
      body: { excludedPaths: [f.candidate.filePath, remapped.filePath] },
    });
  });

  it("rejects a room binding revoked while its current version is checked", async () => {
    const f = await fixture();
    await f.recordOrigin();
    f.adapterMocks.listVersions.mockImplementation(async () => {
      await f.store.transitionAgent({ bindingId: f.room.id, state: "disabled", changedAt: 20 });
      return [{ id: 20, version: "1.0.0", status: "PUBLISHED", downloadAvailable: true }];
    });
    expect((await f.request({ agentId: f.room.agentId, candidates: [f.candidate] })).status).toBe(
      409,
    );
  });

  it.each(["private", "trash", "malware"])(
    "keeps %s installed sources excluded without a discoverable candidate",
    async (state) => {
      const f = await fixture();
      await f.recordOrigin();
      if (state === "private") {
        await f.store.skillHubCatalog.updateMetadata({
          skillId: f.entry!.id,
          actorUserId: f.actor.user.id,
          expectedRevision: f.entry!.revision,
          sharing: { mode: "PRIVATE", userIds: [], scopeIds: [] },
          now: 20,
        });
      } else if (state === "trash") {
        await f.store.skillHubCatalog.trash({
          skillId: f.entry!.id,
          actorUserId: f.actor.user.id,
          expectedRevision: f.entry!.revision,
          now: 20,
        });
      } else {
        await f.store.skillHubCatalog.blockVersion({
          skillId: f.entry!.id,
          version: "1.0.0",
          reason: "Confirmed malicious hash",
          now: 20,
        });
      }
      expect(await f.request({ agentId: f.room.agentId, candidates: [] })).toMatchObject({
        status: 200,
        body: {
          excludedPaths: [],
          excludedSourceDirectories: [path.dirname(f.candidate.filePath)],
        },
      });
    },
  );
});
