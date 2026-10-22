import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { KnoxSpaceAdministrationService } from "./browser-knox-space-http.js";
import { KnoxSelfInSpaceService } from "./knox-self-in-space-service.js";
import type { KnoxSelfSpaceIdentity, KnoxSelfSpaceRoute } from "./knox-space-contracts.js";
import { SpaceConversationService } from "./space-conversation-service.js";
import { parseSpaceReadRequest } from "./space-read-request.js";
import { SpaceService } from "./space-service.js";
import { createSpaceTestFixture } from "./spaces.test-fixtures.js";
import { SqliteControlPlaneStore } from "./sqlite-store.js";

async function fixture() {
  const f = await createSpaceTestFixture();
  f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "editor", 1);
  const room = await f.store.reserveKnoxRoomAgent({
    accountId: "default",
    roomId: "room-a",
    reservedAt: Date.now(),
  });
  await f.store.transitionAgent({
    bindingId: room.binding.id,
    state: "active",
    changedAt: Date.now(),
  });
  const binding = f.store.knoxSpaces.manage(f.alice.user.id, {
    action: "connect",
    accountId: "default",
    roomId: "room-a",
    spaceId: f.space.id,
    pageId: f.page.id,
    expectedGeneration: 0,
  });
  f.request.mockClear();
  const service = new KnoxSelfInSpaceService(f.store, f.service.conversations);
  const identity: KnoxSelfSpaceIdentity = {
    accountId: "default",
    conversationType: "room",
    conversationId: "room-a",
    knoxUserId: "bob",
    executionMode: "self_in_space",
    requestId: "message-one",
    requestFingerprint: createHash("sha256").update("one normalized message").digest("hex"),
  };
  return { ...f, room, binding, selfService: service, identity };
}

function resolved(
  route: Awaited<ReturnType<KnoxSelfInSpaceService["resolve"]>>,
): KnoxSelfSpaceRoute {
  expect(route.status).toBe("resolved");
  if (route.status !== "resolved") {
    throw new Error(`Unexpected ${route.status}`);
  }
  return route;
}

function changeTestDatabase(databasePath: string, change: (db: DatabaseSync) => void) {
  const db = new DatabaseSync(databasePath);
  try {
    change(db);
  } finally {
    db.close();
  }
}

async function prepareReadyVm(f: Awaited<ReturnType<typeof fixture>>) {
  const endpoint = await f.store.createSafeConnectEndpoint({
    actorUserId: f.alice.user.id,
    label: "Test SafeConnect",
    host: "safeconnect.example.test",
    port: 44_422,
    adDomain: "example.test",
    createdAt: Date.now(),
  });
  const sshString = (value: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(value.length);
    return Buffer.concat([length, value]);
  };
  const key = Buffer.concat([
    sshString(Buffer.from("ssh-ed25519")),
    sshString(Buffer.alloc(32, 9)),
  ]);
  await f.store.approveSafeConnectHostKey({
    actorUserId: f.alice.user.id,
    endpointId: endpoint.id,
    algorithm: "ssh-ed25519",
    publicKey: key.toString("base64"),
    fingerprint: `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/u, "")}`,
    approvedAt: Date.now(),
  });
  const host = await f.store.createVmHost({
    actorUserId: f.alice.user.id,
    endpointId: endpoint.id,
    label: "Development VM",
    targetAddress: "192.0.2.10",
    createdAt: Date.now(),
  });
  const allocation = await f.store.assignVmToPersonalAgent({
    actorUserId: f.alice.user.id,
    agentId: f.bob.binding.agentId,
    vmHostId: host.id,
    linuxAccount: "linux-user",
    assignedAt: Date.now(),
  });
  await f.store.recordVmConnectionResult({
    actorUserId: f.alice.user.id,
    agentId: f.bob.binding.agentId,
    expectedAllocationId: allocation.id,
    expectedTargetRevision: 0,
    checkedAt: Date.now(),
    result: {
      status: "ready",
      remoteHomeDir: "/users/linux-user",
      remoteWorkspaceDir: "/users/linux-user/.platformclaw/workspace",
    },
  });
  await f.store.replaceEncryptedUserSshCredential({
    actorUserId: f.bob.user.id,
    userId: f.bob.user.id,
    envelope: {
      ciphertext: new Uint8Array([1]),
      nonce: new Uint8Array(12),
      authTag: new Uint8Array(16),
      keyId: `sha256:${"A".repeat(43)}`,
      formatVersion: 1,
    },
    replacedAt: Date.now(),
  });
  return allocation;
}

describe("Knox personal Space admission", () => {
  it.each([
    ["disabled room", "room-disabled"],
    ["disconnected room", "space-unavailable"],
    ["Viewer", "permission-denied"],
    ["inactive user", "agent-unavailable"],
    ["inactive Agent", "agent-unavailable"],
    ["deleted page", "permission-denied"],
    ["unavailable VM", "agent-unavailable"],
  ] as const)(
    "denies %s before any native session or server fallback",
    async (scenario, status) => {
      const f = await fixture();
      switch (scenario) {
        case "disabled room":
          await f.store.transitionAgent({
            bindingId: f.room.binding.id,
            state: "disabled",
            changedAt: Date.now(),
          });
          break;
        case "disconnected room":
          f.store.knoxSpaces.manage(f.alice.user.id, {
            action: "disconnect",
            accountId: "default",
            roomId: "room-a",
            expectedGeneration: 1,
          });
          break;
        case "Viewer":
          f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "viewer", 2);
          break;
        case "inactive user":
          await f.store.setManagedUserStatus({
            actorUserId: f.alice.user.id,
            targetUserId: f.bob.user.id,
            status: "disabled",
            changedAt: Date.now(),
          });
          break;
        case "inactive Agent":
          await f.store.transitionAgent({
            bindingId: f.bob.binding.id,
            state: "disabled",
            changedAt: Date.now(),
          });
          break;
        case "deleted page":
          changeTestDatabase(f.databasePath, (db) => {
            db.prepare("DELETE FROM collaboration_space_pages WHERE id = ?").run(f.page.id);
          });
          break;
        case "unavailable VM": {
          // Use a real owned selected allocation, then record a connection failure.
          // The schema intentionally rejects an invented or unowned allocation.
          const allocation = await prepareReadyVm(f);
          await f.store.changePersonalExecutionTarget({
            agentId: f.bob.binding.agentId,
            target: "assigned_vm",
            expectedRevision: 0,
            changedAt: Date.now(),
          });
          await f.store.recordVmConnectionResult({
            actorUserId: f.alice.user.id,
            agentId: f.bob.binding.agentId,
            expectedAllocationId: allocation.id,
            expectedTargetRevision: 1,
            checkedAt: Date.now(),
            result: { status: "connection_required", failureCode: "connection-failed" },
          });
          break;
        }
      }
      await expect(f.selfService.resolve(f.identity)).resolves.toMatchObject({ status });
      expect(f.store.knoxSpaces.receipt(f.identity)?.state).toBe("denied");
      expect(f.request).not.toHaveBeenCalled();
      expect(f.store.spaces.sharedConversations(f.alice.user.id, f.space.id)).toHaveLength(0);
    },
  );

  it("rejects a changed target snapshot permanently without rerouting the registered session", async () => {
    const f = await fixture();
    const route = resolved(await f.selfService.resolve(f.identity));
    changeTestDatabase(f.databasePath, (db) => {
      db.prepare(
        "UPDATE personal_execution_profiles SET target_revision = 2 WHERE agent_binding_id = ?",
      ).run(f.bob.binding.id);
    });
    await expect(
      f.selfService.resolve({
        ...f.identity,
        operation: "validate",
        admissionId: route.selfInSpace.admissionId,
      }),
    ).resolves.toMatchObject({ status: "target-changed" });
    changeTestDatabase(f.databasePath, (db) => {
      db.prepare(
        "UPDATE personal_execution_profiles SET target_revision = 0 WHERE agent_binding_id = ?",
      ).run(f.bob.binding.id);
    });
    await expect(f.selfService.resolve(f.identity)).resolves.toMatchObject({
      status: "request-revoked",
    });
    expect(
      f.store.spaces.conversations(f.bob.user.id, f.space.id).map((item) => item.sessionKey),
    ).toEqual([route.sessionKey]);
    expect(f.request).not.toHaveBeenCalled();
  });

  it("atomically cancels the owner's accepted request on a target switch and never revives it on switch-back", async () => {
    const f = await fixture();
    await prepareReadyVm(f);
    const old = resolved(await f.selfService.resolve(f.identity));
    const unaffected = resolved(
      await f.selfService.resolve({
        ...f.identity,
        knoxUserId: "alice",
        requestId: "alice-request",
      }),
    );
    await f.store.changePersonalExecutionTarget({
      agentId: old.agentId,
      target: "assigned_vm",
      expectedRevision: 0,
      changedAt: Date.now(),
    });
    expect(f.store.knoxSpaces.receipt(f.identity)?.state).toBe("revoked");
    await f.store.changePersonalExecutionTarget({
      agentId: old.agentId,
      target: "platform_server",
      expectedRevision: 1,
      changedAt: Date.now(),
    });
    await expect(
      f.service.agentRead({
        agentId: old.agentId,
        sessionKey: old.sessionKey,
        runId: `knox-my:${old.selfInSpace.admissionId}`,
        operation: "context",
      }),
    ).rejects.toThrow("no longer authorized");
    await expect(f.selfService.resolve(f.identity)).resolves.toMatchObject({
      status: "request-revoked",
    });
    await expect(
      f.service.agentRead({
        agentId: unaffected.agentId,
        sessionKey: unaffected.sessionKey,
        runId: `knox-my:${unaffected.selfInSpace.admissionId}`,
        operation: "context",
      }),
    ).resolves.toMatchObject({ conversation: { id: unaffected.selfInSpace.conversationId } });
    const replacement = resolved(
      await f.selfService.resolve({ ...f.identity, requestId: "new-after-switch-back" }),
    );
    expect(replacement.sessionKey).toBe(old.sessionKey);
    expect(replacement.selfInSpace.targetRevision).toBe(2);
    expect(f.request).not.toHaveBeenCalled();
  });

  it.each(["credential", "allocation"] as const)(
    "rejects a changed VM %s identity at the actual Space tool boundary without dispatch validation",
    async (change) => {
      const f = await fixture();
      const allocation = await prepareReadyVm(f);
      await f.store.changePersonalExecutionTarget({
        agentId: f.bob.binding.agentId,
        target: "assigned_vm",
        expectedRevision: 0,
        changedAt: Date.now(),
      });
      const route = resolved(await f.selfService.resolve(f.identity));
      const target = await f.store.resolvePersonalExecutionTarget(route.agentId);
      if (target.kind !== "assigned_vm") {
        throw new Error("Expected an owned VM target");
      }
      const lookup = vi.spyOn(f.store, "resolvePersonalExecutionTarget");
      try {
        if (change === "credential") {
          await f.store.replaceEncryptedUserSshCredential({
            actorUserId: f.bob.user.id,
            userId: f.bob.user.id,
            envelope: {
              ciphertext: new Uint8Array([2]),
              nonce: new Uint8Array(12),
              authTag: new Uint8Array(16),
              keyId: `sha256:${"A".repeat(43)}`,
              formatVersion: 1,
            },
            replacedAt: Date.now(),
          });
        } else {
          // Isolate allocation comparison at the real admission/tool boundary.
          // Canonical target replacement and permanent revocation are covered above.
          lookup.mockResolvedValue({
            ...target,
            allocationId: `${allocation.id}-replacement`,
          });
        }
        await expect(f.store.resolvePersonalExecutionTarget(route.agentId)).resolves.toMatchObject({
          kind: "assigned_vm",
          revision: 1,
          ...(change === "credential"
            ? { credentialRevision: 2 }
            : { allocationId: `${allocation.id}-replacement` }),
        });
        const context = {
          agentId: route.agentId,
          sessionKey: route.sessionKey,
          runId: `knox-my:${route.selfInSpace.admissionId}`,
          operation: "context" as const,
        };
        await expect(f.service.agentRead(context)).rejects.toThrow("no longer authorized");
        expect(f.store.knoxSpaces.receipt(f.identity)?.state).toBe("revoked");
        await expect(
          f.service.agentRead({ ...context, runId: "independent-web-run" }),
        ).resolves.toMatchObject({ conversation: { id: route.selfInSpace.conversationId } });
        expect(f.request).not.toHaveBeenCalled();
      } finally {
        lookup.mockRestore();
      }
    },
  );

  it("rechecks the durable receipt after an asynchronous tool target lookup crosses a target change", async () => {
    const f = await fixture();
    const route = resolved(await f.selfService.resolve(f.identity));
    const resolveTarget = f.store.resolvePersonalExecutionTarget.bind(f.store);
    const lookup = vi
      .spyOn(f.store, "resolvePersonalExecutionTarget")
      .mockImplementationOnce(async (...args) => {
        const oldSnapshot = await resolveTarget(...args);
        await f.store.changePersonalExecutionTarget({
          agentId: route.agentId,
          target: "platform_server",
          expectedRevision: 0,
          changedAt: Date.now(),
        });
        return oldSnapshot;
      });
    try {
      await expect(
        f.service.agentRead({
          agentId: route.agentId,
          sessionKey: route.sessionKey,
          runId: `knox-my:${route.selfInSpace.admissionId}`,
          operation: "context",
        }),
      ).rejects.toThrow("no longer authorized");
      expect(f.store.knoxSpaces.receipt(f.identity)?.state).toBe("revoked");
      expect(f.request).not.toHaveBeenCalled();
    } finally {
      lookup.mockRestore();
    }
  });

  it("honors the exact 200-session Space cap while reusing an already registered Knox conversation", async () => {
    const f = await fixture();
    for (let index = 0; index < 199; index++) {
      f.store.spaces.createConversation(f.alice.user.id, f.space.id, {
        pageId: f.page.id,
        title: "Existing web conversation",
        requestId: `existing-${index}`,
      });
    }
    const route = resolved(await f.selfService.resolve(f.identity));
    expect(f.store.spaces.sharedConversations(f.alice.user.id, f.space.id)).toHaveLength(200);
    const reused = resolved(
      await f.selfService.resolve({ ...f.identity, requestId: "reuse-at-capacity" }),
    );
    expect(reused.sessionKey).toBe(route.sessionKey);
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.carol.user.id, "editor", 2);
    await expect(
      f.selfService.resolve({ ...f.identity, requestId: "over-capacity", knoxUserId: "carol" }),
    ).resolves.toMatchObject({ status: "space-unavailable" });
    expect(f.store.spaces.sharedConversations(f.alice.user.id, f.space.id)).toHaveLength(200);
    expect(f.store.spaces.conversations(f.carol.user.id, f.space.id)).toHaveLength(0);
    expect(f.request).not.toHaveBeenCalled();
  });
  it("registers before Gateway work and converges concurrent requests on one dedicated conversation", async () => {
    const f = await fixture();
    const routes = await Promise.all([
      f.selfService.resolve(f.identity),
      f.selfService.resolve({ ...f.identity, requestId: "message-two" }),
      f.selfService.resolve(f.identity),
    ]);
    const first = resolved(routes[0]!);
    expect(routes[2]).toEqual(first);
    expect(resolved(routes[1]!).sessionKey).toBe(first.sessionKey);
    expect(f.store.spaces.conversations(f.bob.user.id, f.space.id)).toHaveLength(1);
    expect(f.request).not.toHaveBeenCalled();
    expect(first).toMatchObject({
      agentId: f.bob.binding.agentId,
      executionTarget: "platform_server",
      selfInSpace: {
        userId: f.bob.user.id,
        requestId: f.identity.requestId,
        targetRevision: 0,
        bindingId: f.binding.id,
        bindingGeneration: 1,
        senderAttribution: { id: "bob", profileId: f.bob.user.id, agentId: f.bob.binding.agentId },
      },
    });
    expect(first.sessionKey).not.toBe(`agent:${f.bob.binding.agentId}:main`);
    await expect(
      f.selfService.resolve({
        ...f.identity,
        operation: "validate",
        admissionId: first.selfInSpace.admissionId,
      }),
    ).resolves.toEqual(first);
    expect(f.request).toHaveBeenCalledWith(
      "sessions.create",
      expect.objectContaining({ key: first.sessionKey }),
    );
  });

  it("keeps denied and conflicting identities permanent rather than adopting later grants", async () => {
    const f = await fixture();
    const identity = { ...f.identity, knoxUserId: "carol" };
    await expect(f.selfService.resolve(identity)).resolves.toMatchObject({
      status: "permission-denied",
    });
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.carol.user.id, "editor", 2);
    await expect(f.selfService.resolve(identity)).resolves.toMatchObject({
      status: "permission-denied",
    });
    await expect(
      f.selfService.resolve({ ...identity, requestFingerprint: "a".repeat(64) }),
    ).resolves.toMatchObject({ status: "request-conflict" });
    expect(f.store.spaces.conversations(f.carol.user.id, f.space.id)).toHaveLength(0);
  });

  it("does not revoke one employee when another member changes", async () => {
    const f = await fixture();
    const route = resolved(await f.selfService.resolve(f.identity));
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.carol.user.id, "viewer", 2);
    await expect(
      f.selfService.resolve({
        ...f.identity,
        operation: "validate",
        phase: "publish",
        admissionId: route.selfInSpace.admissionId,
      }),
    ).resolves.toEqual(route);
    expect(f.request).not.toHaveBeenCalled();
  });

  it("never revives a queued request after revoke, re-grant, and a new store instance", async () => {
    const f = await fixture();
    const route = resolved(await f.selfService.resolve(f.identity));
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "viewer", 2);
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "editor", 3);
    const reopened = new SqliteControlPlaneStore({
      databasePath: f.databasePath,
      initialAdminAccountIds: ["alice"],
      buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
    });
    try {
      const service = new KnoxSelfInSpaceService(
        reopened,
        new SpaceConversationService(reopened.spaces, { request: f.request }),
      );
      await expect(service.resolve(f.identity)).resolves.toMatchObject({
        status: "request-revoked",
      });
      await expect(
        service.resolve({
          ...f.identity,
          operation: "validate",
          admissionId: route.selfInSpace.admissionId,
        }),
      ).resolves.toMatchObject({ status: "request-revoked" });
      expect(() =>
        reopened.knoxSpaces.assertRun(route.sessionKey, `knox-my:${route.selfInSpace.admissionId}`),
      ).toThrow("no longer authorized");
      expect(() =>
        reopened.knoxSpaces.assertRun(route.sessionKey, "independent-web-run"),
      ).not.toThrow();
      const engineService = new SpaceService(reopened, { request: f.request });
      const oldToolContext = parseSpaceReadRequest(
        {
          operation: "context",
          sessionKey: route.sessionKey,
          runId: `knox-my:${route.selfInSpace.admissionId}`,
        },
        route.agentId,
      );
      await expect(engineService.agentRead(oldToolContext)).rejects.toThrow("no longer authorized");
      await expect(
        engineService.agentRead(
          parseSpaceReadRequest(
            { operation: "context", sessionKey: route.sessionKey, runId: "independent-web-run" },
            route.agentId,
          ),
        ),
      ).resolves.toMatchObject({ conversation: { id: route.selfInSpace.conversationId } });
      expect(f.request).not.toHaveBeenCalled();
    } finally {
      reopened.close();
    }
  });

  it("changes binding generation on page reassignment and aborts only the old native run", async () => {
    const f = await fixture();
    const old = resolved(await f.selfService.resolve(f.identity));
    const page = f.store.spaces.createPage(f.alice.user.id, f.space.id, {
      title: "Other issue",
      body: "",
      requestId: "other-issue",
    });
    const admin = new KnoxSpaceAdministrationService(f.auth, f.store.knoxSpaces, {
      request: f.request,
    });
    await admin.mutate(f.alice.user.id, {
      action: "connect",
      accountId: "default",
      roomId: "room-a",
      expectedGeneration: 1,
      spaceId: f.space.id,
      pageId: page.id,
    });
    expect(f.request).toHaveBeenCalledWith("chat.abort", {
      agentId: old.agentId,
      sessionKey: old.sessionKey,
      runId: `knox-my:${old.selfInSpace.admissionId}`,
    });
    expect(f.request).not.toHaveBeenCalledWith("sessions.abort", expect.anything());
    await expect(f.selfService.resolve(f.identity)).resolves.toMatchObject({
      status: "request-revoked",
    });
    const next = resolved(
      await f.selfService.resolve({ ...f.identity, requestId: "after-rebind" }),
    );
    expect(next.selfInSpace).toMatchObject({ bindingGeneration: 2, pageId: page.id });
    expect(next.sessionKey).not.toBe(old.sessionKey);
  });

  it("requires administrator authority and owner access to connect a real registered room", async () => {
    const f = await fixture();
    expect(() =>
      f.store.knoxSpaces.manage(f.bob.user.id, {
        action: "connect",
        accountId: "default",
        roomId: "room-a",
        expectedGeneration: 1,
        spaceId: f.space.id,
        pageId: f.page.id,
      }),
    ).toThrow("Administrator");
    expect(() =>
      f.store.knoxSpaces.manage(f.alice.user.id, {
        action: "connect",
        accountId: "default",
        roomId: "unknown-room",
        expectedGeneration: 0,
        spaceId: f.space.id,
        pageId: f.page.id,
      }),
    ).toThrow("active registered Knox room");
    expect(() =>
      f.store.knoxSpaces.manage(f.alice.user.id, {
        action: "disconnect",
        accountId: "default",
        roomId: "room-a",
        expectedGeneration: 0,
      }),
    ).toThrow("reload");
  });

  it("retains a terminal receipt and does not create another session on settled replay", async () => {
    const f = await fixture();
    const route = resolved(await f.selfService.resolve(f.identity));
    await expect(
      f.selfService.resolve({
        ...f.identity,
        operation: "settle",
        outcome: "finished",
        admissionId: route.selfInSpace.admissionId,
      }),
    ).resolves.toMatchObject({ status: "request-settled" });
    await expect(f.selfService.resolve(f.identity)).resolves.toMatchObject({
      status: "request-settled",
    });
    expect(f.store.spaces.conversations(f.bob.user.id, f.space.id)).toHaveLength(1);
    expect(f.request).not.toHaveBeenCalled();
  });

  it("shares attributed questions and final answers through the existing projection while withholding tools", async () => {
    const f = await fixture();
    const route = resolved(await f.selfService.resolve(f.identity));
    const messages = [
      {
        role: "user",
        content: "project finding question",
        __openclaw: { id: "question", senderProfileId: f.bob.user.id },
      },
      {
        role: "assistant",
        phase: "final_answer",
        content: "project finding answer",
        __openclaw: { id: "answer" },
      },
      {
        role: "toolResult",
        content: "project finding private tool data",
        __openclaw: { id: "tool" },
      },
    ];
    f.request.mockImplementation(async (method, params) => {
      if (method === "sessions.search") {
        return {
          results: messages.map((message) => ({
            sessionKey: route.sessionKey,
            messageId: message["__openclaw"].id,
          })),
        };
      }
      if (method === "chat.history") {
        return { sessionKey: (params as { sessionKey: string }).sessionKey, messages };
      }
      return {};
    });
    const search = await f.service.agentRead({
      agentId: f.alice.binding.agentId,
      sessionKey: `agent:${f.alice.binding.agentId}:main`,
      operation: "search",
      query: "project finding",
      spaceId: f.space.id,
    });
    const serialized = JSON.stringify(search);
    expect(serialized).toContain("project finding question");
    expect(serialized).toContain("project finding answer");
    expect(serialized).not.toContain("private tool data");
    await expect(
      f.service.agentRead({
        agentId: f.alice.binding.agentId,
        sessionKey: `agent:${f.alice.binding.agentId}:main`,
        operation: "get",
        spaceId: f.space.id,
        pageId: f.page.id,
        conversationId: route.selfInSpace.conversationId,
      }),
    ).resolves.toMatchObject({ messages: expect.any(Array) });
    expect(f.service.conversations.canAccessNative(f.alice.user.id, route.sessionKey)).toBe(false);
  });
});
