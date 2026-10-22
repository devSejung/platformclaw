import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { readBrowserJsonBody } from "./browser-http-shared.js";
import {
  handleKnoxSpaceAdministrationRequest,
  KnoxSpaceAdministrationService,
} from "./browser-knox-space-http.js";
import {
  handlePlatformClawKnoxRoutingRequest,
  PLATFORMCLAW_KNOX_ROUTING_PATH,
} from "./knox-routing-http.js";
import { KnoxRoutingService } from "./knox-routing-service.js";
import { KnoxSelfInSpaceService } from "./knox-self-in-space-service.js";
import { createSpaceTestFixture } from "./spaces.test-fixtures.js";

const PLATFORMCLAW_KNOX_SPACE_ADMIN_PATH = "/platformclaw/api/admin/knox-space-bindings";

describe("Knox Space HTTP authority boundaries", () => {
  it("uses admin cookie/origin management and service authentication for personal routing", async () => {
    const f = await createSpaceTestFixture();
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
    const admin = new KnoxSpaceAdministrationService(f.auth, f.store.knoxSpaces, {
      request: f.request,
    });
    const routing = new KnoxRoutingService({
      store: f.store,
      roomProvisioner: { provision: vi.fn() },
      buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
      selfInSpace: new KnoxSelfInSpaceService(f.store, f.service.conversations),
    });
    const server = createServer((req, res) => {
      void (async () => {
        if (
          await handleKnoxSpaceAdministrationRequest(req, res, {
            service: admin,
            readJsonBody: readBrowserJsonBody,
            isMutationOriginAllowed: (request) =>
              request.headers.origin === "https://platformclaw.example",
          })
        ) {
          return;
        }
        if (
          await handlePlatformClawKnoxRoutingRequest(req, res, {
            service: routing,
            serviceToken: "fixture-service-token",
            readJsonBody: readBrowserJsonBody,
          })
        ) {
          return;
        }
        res.writeHead(404).end();
      })().catch(() => res.writeHead(500).end());
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Test listener unavailable");
    }
    const origin = `http://127.0.0.1:${address.port}`;
    const connect = {
      action: "connect",
      accountId: "default",
      roomId: "room-a",
      spaceId: f.space.id,
      pageId: f.page.id,
      expectedGeneration: 0,
    };
    try {
      expect((await fetch(origin + PLATFORMCLAW_KNOX_SPACE_ADMIN_PATH)).status).toBe(401);
      expect(
        (
          await fetch(origin + PLATFORMCLAW_KNOX_SPACE_ADMIN_PATH, {
            headers: { Cookie: "platformclaw_session=bob" },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await fetch(origin + PLATFORMCLAW_KNOX_SPACE_ADMIN_PATH, {
            method: "POST",
            headers: { Cookie: "platformclaw_session=alice", Origin: "https://other.example" },
            body: JSON.stringify(connect),
          })
        ).status,
      ).toBe(403);
      const connected = await fetch(origin + PLATFORMCLAW_KNOX_SPACE_ADMIN_PATH, {
        method: "POST",
        headers: { Cookie: "platformclaw_session=alice", Origin: "https://platformclaw.example" },
        body: JSON.stringify(connect),
      });
      expect(connected.status).toBe(200);
      expect(await connected.json()).toMatchObject({
        connection: { generation: 1, state: "active" },
      });
      const request = {
        accountId: "default",
        conversationType: "room",
        conversationId: "room-a",
        knoxUserId: "alice",
        executionMode: "self_in_space",
        requestId: "message-a",
        requestFingerprint: "a".repeat(64),
      };
      expect(
        (
          await fetch(origin + PLATFORMCLAW_KNOX_ROUTING_PATH, {
            method: "POST",
            body: JSON.stringify(request),
          })
        ).status,
      ).toBe(401);
      f.request.mockClear();
      const reserved = await fetch(origin + PLATFORMCLAW_KNOX_ROUTING_PATH, {
        method: "POST",
        headers: { Authorization: "Bearer fixture-service-token" },
        body: JSON.stringify(request),
      });
      expect(reserved.status).toBe(200);
      const reservedBody = (await reserved.json()) as {
        selfInSpace: { admissionId: string };
        sessionKey: string;
      };
      expect(reservedBody).toMatchObject({
        ok: true,
        status: "resolved",
        agentId: f.alice.binding.agentId,
        selfInSpace: { userId: f.alice.user.id, bindingGeneration: 1 },
      });
      expect(f.request).not.toHaveBeenCalled();
      const callRoute = async (body: Record<string, unknown>) => {
        const response = await fetch(origin + PLATFORMCLAW_KNOX_ROUTING_PATH, {
          method: "POST",
          headers: { Authorization: "Bearer fixture-service-token" },
          body: JSON.stringify(body),
        });
        return { status: response.status, body: await response.json() };
      };
      const validation = {
        ...request,
        operation: "validate",
        admissionId: reservedBody.selfInSpace.admissionId,
      };
      for (const invalid of [
        { ...request, executionMode: "unknown" },
        { ...request, conversationType: "dm" },
        { ...request, executionMode: undefined },
        { ...request, requestId: undefined },
        { ...request, requestFingerprint: undefined },
        { ...validation, admissionId: undefined },
        { ...validation, phase: "unrecognized" },
      ]) {
        expect(await callRoute(invalid)).toMatchObject({
          status: 400,
          body: { error: "invalid_request" },
        });
      }
      for (const changed of [
        { ...validation, admissionId: "other-admission" },
        { ...validation, requestFingerprint: "b".repeat(64) },
        { ...validation, conversationId: "other-room" },
        { ...validation, knoxUserId: "bob" },
      ]) {
        expect(await callRoute(changed)).toMatchObject({
          status: 200,
          body: { status: "request-conflict" },
        });
      }
      expect(f.request).not.toHaveBeenCalled();
      expect(await callRoute(validation)).toMatchObject({
        status: 200,
        body: {
          status: "resolved",
          sessionKey: reservedBody.sessionKey,
          selfInSpace: { admissionId: reservedBody.selfInSpace.admissionId },
        },
      });
      expect(f.request).toHaveBeenCalledWith(
        "sessions.create",
        expect.objectContaining({ key: reservedBody.sessionKey }),
      );
      f.request.mockClear();
      expect(await callRoute({ ...validation, phase: "publish" })).toMatchObject({
        status: 200,
        body: { status: "resolved", sessionKey: reservedBody.sessionKey },
      });
      expect(f.request).not.toHaveBeenCalled();
      expect(
        await callRoute({ ...validation, operation: "settle", outcome: "finished" }),
      ).toMatchObject({ status: 200, body: { status: "request-settled" } });
      expect(await callRoute(request)).toMatchObject({
        status: 200,
        body: { status: "request-settled" },
      });
      expect(f.request).not.toHaveBeenCalled();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
