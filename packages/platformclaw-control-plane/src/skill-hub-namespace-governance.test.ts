import { describe, expect, it, vi } from "vitest";
import { IflytekSkillHubGovernanceClient } from "./skill-hub-governance-client.js";

const operationId = "29dbbbd1-4d41-4d94-b26b-6b33e7cd24b6";
const namespace = "team-tools";
const description = `PlatformClaw namespace operation:${operationId}`;

function reply(data: unknown, status = 200, msg = "success", cookies: string[] = []) {
  const headers = new Headers({ "content-type": "application/json" });
  for (const cookie of cookies) {
    headers.append("set-cookie", cookie);
  }
  return new Response(JSON.stringify({ code: status === 200 ? 0 : status, data, msg }), {
    status,
    headers,
  });
}

function fixture(initial?: { description: string }) {
  let native = initial ? { id: 12, slug: namespace, status: "ACTIVE", ...initial } : undefined;
  let loseResponse = false;
  let getError: string | undefined;
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.endsWith("/auth/methods")) {
      return reply({}, 200, "success", ["XSRF-TOKEN=csrf; Path=/"]);
    }
    if (url.pathname.endsWith("/auth/direct/login")) {
      return reply({}, 200, "success", ["SESSION=test-session; HttpOnly; Path=/"]);
    }
    expect(new Headers(init?.headers).get("Cookie")).toContain("SESSION=test-session");
    expect(new Headers(init?.headers).get("Accept-Language")).toBe("en");
    expect(new Headers(init?.headers).get("Authorization")).toBeNull();
    if (init?.method === "GET") {
      return native
        ? reply(native)
        : reply(null, 400, getError ?? `Namespace not found: ${namespace}`);
    }
    expect(url.pathname).toBe("/api/v1/namespaces");
    expect(new Headers(init?.headers).get("X-XSRF-TOKEN")).toBe("csrf");
    if (typeof init?.body !== "string") {
      throw new Error("expected JSON namespace body");
    }
    const body = JSON.parse(init.body);
    expect(body).toEqual({ slug: namespace, displayName: namespace, description });
    native = { id: 12, slug: namespace, status: "ACTIVE", description: body.description };
    if (loseResponse) {
      loseResponse = false;
      throw new Error("response lost after commit");
    }
    return reply(native);
  });
  const client = new IflytekSkillHubGovernanceClient({
    baseUrl: "http://registry.example.test",
    username: "bootstrap",
    password: "test-only",
    fetchImpl,
  });
  return {
    client,
    fetchImpl,
    loseNextResponse: () => {
      loseResponse = true;
    },
    rejectGet: (message: string) => {
      getError = message;
    },
  };
}

describe("Skill Hub native namespace contract", () => {
  it("creates with a private CSRF session and durable operation marker", async () => {
    const { client, fetchImpl } = fixture();
    await expect(client.createNamespace({ namespace, operationId })).resolves.toEqual({
      id: 12,
      namespace,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("recovers only the exact persisted marker after a lost creation response", async () => {
    const { client, fetchImpl, loseNextResponse } = fixture();
    loseNextResponse();
    await expect(client.createNamespace({ namespace, operationId })).rejects.toThrow("unavailable");
    await expect(client.createNamespace({ namespace, operationId })).resolves.toEqual({
      id: 12,
      namespace,
    });
    expect(
      fetchImpl.mock.calls.filter(
        ([, init]) =>
          init?.method === "POST" && typeof init.body === "string" && init.body.includes('"slug"'),
      ),
    ).toHaveLength(1);
  });

  it("never adopts a pre-existing registry namespace or posts after discovering it", async () => {
    const { client, fetchImpl } = fixture({ description: "Existing namespace" });
    await expect(client.createNamespace({ namespace, operationId })).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("does not mistake arbitrary HTTP400 failures for namespace absence", async () => {
    const { client, fetchImpl, rejectGet } = fixture();
    rejectGet("request denied by a proxy");
    await expect(client.createNamespace({ namespace, operationId })).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
