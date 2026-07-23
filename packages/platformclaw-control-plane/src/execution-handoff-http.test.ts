import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PLATFORMCLAW_EXECUTION_GRANT_PATH,
  PLATFORMCLAW_EXECUTION_TARGET_PATH,
  PlatformClawExecutionHandoffServer,
} from "./execution-handoff-http.js";
import type { ExecutionHandoffService } from "./execution-handoff-service.js";

const servers: PlatformClawExecutionHandoffServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => await server.close()));
});

async function startServer() {
  const service = {
    resolveTarget: vi.fn(async (agentId: string) => ({
      kind: "platform_server" as const,
      agentId,
      targetId: "platform-server" as const,
      revision: 0,
    })),
    issueCredentialGrant: vi.fn(async () => ({
      token: "grant-token",
      expiresAt: 30_000,
      brokerAddress: "/run/platformclaw/runtime.sock",
      agentId: "person_one",
      allocationId: "allocation-one",
      targetRevision: 4,
    })),
  } satisfies Pick<ExecutionHandoffService, "resolveTarget" | "issueCredentialGrant">;
  const server = new PlatformClawExecutionHandoffServer(
    "service-token-that-is-at-least-32-bytes",
    service,
  );
  servers.push(server);
  await server.listen({ host: "127.0.0.1", port: 0 });
  const port = (server.address() as AddressInfo).port;
  return { service, origin: `http://127.0.0.1:${port}` };
}

function request(origin: string, path: string, body: unknown, token?: string): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("PlatformClawExecutionHandoffServer", () => {
  it("rejects missing and incorrect service tokens before dispatch", async () => {
    const { origin, service } = await startServer();

    for (const token of [undefined, "wrong-token"]) {
      const response = await request(
        origin,
        PLATFORMCLAW_EXECUTION_TARGET_PATH,
        { agentId: "person_one" },
        token,
      );
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    }
    expect(service.resolveTarget).not.toHaveBeenCalled();
  });

  it("serves target and grant calls only to the authenticated internal client", async () => {
    const { origin, service } = await startServer();
    const token = "service-token-that-is-at-least-32-bytes";

    const target = await request(
      origin,
      PLATFORMCLAW_EXECUTION_TARGET_PATH,
      { agentId: "person_one" },
      token,
    );
    expect(target.status).toBe(200);
    await expect(target.json()).resolves.toMatchObject({
      kind: "platform_server",
      agentId: "person_one",
    });

    const grant = await request(
      origin,
      PLATFORMCLAW_EXECUTION_GRANT_PATH,
      { agentId: "person_one", allocationId: "allocation-one", targetRevision: 4 },
      token,
    );
    expect(grant.status).toBe(200);
    await expect(grant.json()).resolves.toMatchObject({
      token: "grant-token",
      allocationId: "allocation-one",
      targetRevision: 4,
    });
    expect(service.resolveTarget).toHaveBeenCalledWith("person_one");
    expect(service.issueCredentialGrant).toHaveBeenCalledWith({
      agentId: "person_one",
      allocationId: "allocation-one",
      targetRevision: 4,
    });
  });

  it("returns a redacted failure for malformed or unavailable targets", async () => {
    const { origin, service } = await startServer();
    service.resolveTarget.mockRejectedValueOnce(new Error("private database detail"));

    const response = await request(
      origin,
      PLATFORMCLAW_EXECUTION_TARGET_PATH,
      { agentId: "person_one" },
      "service-token-that-is-at-least-32-bytes",
    );
    expect(response.status).toBe(409);
    await expect(response.text()).resolves.not.toContain("private database detail");
  });
});
