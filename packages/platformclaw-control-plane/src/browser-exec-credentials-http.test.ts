import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { handlePlatformClawExecCredentialRequest } from "./browser-exec-credentials-http.js";
import { readBrowserJsonBody } from "./browser-http-shared.js";
import { createExecCredentialTestContext } from "./exec-credential.test-support.js";

const cleanups: (() => Promise<void>)[] = [];
async function setup(afterBodyRead?: () => Promise<void>) {
  const context = await createExecCredentialTestContext();
  await context.service.addDefinition(context.admin.user.id, "API_TOKEN");
  const server = createServer((req, res) => {
    void handlePlatformClawExecCredentialRequest(req, res, {
      service: context.service,
      readJsonBody: async (request, maxBytes) => {
        const result = await readBrowserJsonBody(request, maxBytes);
        await afterBodyRead?.();
        return result;
      },
      isMutationOriginAllowed: (request) => request.headers.origin === origin,
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
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("HTTP fixture did not bind TCP");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    context.close();
  });
  return {
    ...context,
    request(
      path: "personal" | "admin",
      body?: Record<string, unknown>,
      token = context.member.token,
    ) {
      return fetch(
        `${origin}/platformclaw/api/${path === "admin" ? "admin/" : ""}exec-credentials`,
        {
          method: body ? "POST" : "GET",
          headers: {
            Cookie: `platformclaw_session=${token}`,
            Origin: origin,
            "Content-Type": "application/json",
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        },
      );
    },
  };
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

describe("exec credential HTTP with real sessions and SQLite", () => {
  it("returns account-bound metadata and reports stale writes as typed conflicts without exposing secrets", async () => {
    const c = await setup();
    const initial = await c.preconditions(c.member.user, "API_TOKEN");
    const response = await c.request("personal");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      accountId: "member.user",
      definitions: [
        {
          envName: "API_TOKEN",
          configured: false,
          definitionToken: initial.expectedDefinitionToken,
          credentialToken: null,
        },
      ],
    });
    const body = {
      action: "replace",
      envName: "API_TOKEN",
      value: "synthetic-first-value",
      expectedAccountId: "member.user",
      ...initial,
    };
    const saved = await c.request("personal", body);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      envName: "API_TOKEN",
      revision: 1,
      definitionToken: initial.expectedDefinitionToken,
      credentialToken: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    const stale = await c.request("personal", { ...body, value: "synthetic-stale-secret" });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({
      code: "credential-changed",
      error: "Credential changed. Reload before saving.",
    });
    expect(await c.service.resolveForAgent(c.member.agentId)).toEqual({
      API_TOKEN: "synthetic-first-value",
    });
    const metadata = await c.request("personal");
    expect(await metadata.text()).not.toContain("synthetic-first-value");
  });

  it.each(["expectedAccountId", "expectedDefinitionToken", "expectedCredentialToken"])(
    "rejects a missing %s instead of performing an unchecked mutation",
    async (field) => {
      const c = await setup();
      const body: Record<string, unknown> = {
        action: "replace",
        envName: "API_TOKEN",
        value: "synthetic-only",
        expectedAccountId: "member.user",
        ...(await c.preconditions(c.member.user, "API_TOKEN")),
      };
      delete body[field];
      const response = await c.request("personal", body);
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain("synthetic-only");
      expect(await c.service.resolveForAgent(c.member.agentId)).toEqual({});
    },
  );

  it.each(["personal", "admin"] as const)(
    "rejects an old account's %s action before any mutation",
    async (path) => {
      const c = await setup();
      const response = await c.request(
        path,
        {
          action: path === "admin" ? "add" : "replace",
          envName: "API_TOKEN",
          value: "synthetic-only",
          expectedAccountId: "prior-account",
          ...(await c.preconditions(c.member.user, "API_TOKEN")),
        },
        path === "admin" ? c.admin.token : c.member.token,
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "credential-account-changed" });
      expect(await c.service.resolveForAgent(c.member.agentId)).toEqual({});
    },
  );

  it("keeps cookie ownership authoritative and guards personal deletion with the current value token", async () => {
    const c = await setup();
    const other = await c.account("other.user");
    const initial = await c.preconditions(c.member.user, "API_TOKEN");
    const saved = await c.request("personal", {
      action: "replace",
      envName: "API_TOKEN",
      value: "synthetic-only",
      userId: other.user.id,
      expectedAccountId: "member.user",
      ...initial,
    });
    expect(saved.status).toBe(200);
    expect(await c.service.resolveForAgent(other.agentId)).toEqual({});
    const stale = await c.request("personal", {
      action: "remove",
      envName: "API_TOKEN",
      expectedAccountId: "member.user",
      ...initial,
    });
    expect(stale.status).toBe(409);
    const current = await c.preconditions(c.member.user, "API_TOKEN");
    const removed = await c.request("personal", {
      action: "remove",
      envName: "API_TOKEN",
      expectedAccountId: "member.user",
      ...current,
    });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({
      deleted: true,
      envName: "API_TOKEN",
      definitionToken: current.expectedDefinitionToken,
      credentialToken: null,
    });
    expect(await c.service.resolveForAgent(c.member.agentId)).toEqual({});
  });

  it("keeps allowlist changes admin-only and detects a removed-and-recreated definition", async () => {
    const c = await setup();
    expect((await c.request("admin")).status).toBe(403);
    expect(
      (
        await c.request("admin", {
          action: "add",
          envName: "OTHER_TOKEN",
          expectedAccountId: "member.user",
        })
      ).status,
    ).toBe(403);
    const initial = await c.preconditions(c.member.user, "API_TOKEN");
    await c.service.replace(c.member.user.id, "API_TOKEN", "synthetic-only", initial);
    const removed = await c.request(
      "admin",
      {
        action: "remove",
        envName: "API_TOKEN",
        expectedAccountId: "admin.user",
        expectedDefinitionToken: initial.expectedDefinitionToken,
      },
      c.admin.token,
    );
    expect(removed.status).toBe(200);
    expect(await c.service.resolveForAgent(c.member.agentId)).toEqual({});
    const added = await c.request(
      "admin",
      { action: "add", envName: "API_TOKEN", expectedAccountId: "admin.user" },
      c.admin.token,
    );
    expect(added.status).toBe(200);
    const stale = await c.request(
      "admin",
      {
        action: "remove",
        envName: "API_TOKEN",
        expectedAccountId: "admin.user",
        expectedDefinitionToken: initial.expectedDefinitionToken,
      },
      c.admin.token,
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "credential-changed" });
    expect((await c.service.snapshot(c.member.user.id)).definitions).toHaveLength(1);
  });

  it("rechecks session revocation after awaiting the request body", async () => {
    const hook = { run: async () => {} };
    const c = await setup(() => hook.run());
    const initial = await c.preconditions(c.member.user, "API_TOKEN");
    hook.run = async () => {
      await c.authService.logout(c.member.token);
    };
    const response = await c.request("personal", {
      action: "replace",
      envName: "API_TOKEN",
      value: "synthetic-only",
      expectedAccountId: "member.user",
      ...initial,
    });
    expect(response.status).toBe(401);
    expect(await c.service.resolveForAgent(c.member.agentId)).toEqual({});
  });
});
