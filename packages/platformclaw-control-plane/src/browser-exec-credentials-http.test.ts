import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { handlePlatformClawExecCredentialRequest } from "./browser-exec-credentials-http.js";
import type { ExecCredentialService } from "./exec-credential-service.js";

function responseHarness(): { response: ServerResponse; body(): unknown } {
  let responseBody = "";
  return {
    response: {
      statusCode: 200,
      setHeader: vi.fn(),
      end: (body?: unknown) => {
        responseBody = typeof body === "string" ? body : "";
      },
    } as unknown as ServerResponse,
    body: () => JSON.parse(responseBody) as unknown,
  };
}

describe("exec credential HTTP", () => {
  it("returns the authenticated account with personal metadata", async () => {
    const harness = responseHarness();
    const snapshot = vi.fn(async () => ({ definitions: [] }));
    const service = {
      authenticate: vi.fn(async () => ({ user: { id: "user-b", accountId: "account-b" } })),
      snapshot,
    } as unknown as ExecCredentialService;
    await handlePlatformClawExecCredentialRequest(
      {
        url: "/platformclaw/api/exec-credentials",
        method: "GET",
        headers: { cookie: "platformclaw_session=synthetic" },
      } as IncomingMessage,
      harness.response,
      {
        service,
        readJsonBody: vi.fn(),
        isMutationOriginAllowed: () => true,
      },
    );
    expect(harness.body()).toEqual({ definitions: [], accountId: "account-b" });
    expect(snapshot).toHaveBeenCalledWith("user-b");
  });

  it.each(["replace", "remove"])(
    "rejects a stale-account %s before any mutation",
    async (action) => {
      const harness = responseHarness();
      const replace = vi.fn();
      const remove = vi.fn();
      const service = {
        authenticate: vi.fn(async () => ({ user: { id: "user-b", accountId: "account-b" } })),
        replace,
        remove,
      } as unknown as ExecCredentialService;
      await handlePlatformClawExecCredentialRequest(
        {
          url: "/platformclaw/api/exec-credentials",
          method: "POST",
          headers: { cookie: "platformclaw_session=synthetic" },
        } as IncomingMessage,
        harness.response,
        {
          service,
          readJsonBody: vi.fn(async () => ({
            ok: true as const,
            value: {
              action,
              envName: "REPORT_API_TOKEN",
              value: "synthetic-only",
              expectedAccountId: "account-a",
            },
          })),
          isMutationOriginAllowed: () => true,
        },
      );
      expect(harness.response.statusCode).toBe(409);
      expect(harness.body()).toMatchObject({ code: "credential-account-changed" });
      expect(replace).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
      expect(JSON.stringify(harness.body())).not.toContain("synthetic-only");
    },
  );

  it.each([undefined, "account-b"])(
    "keeps cookie ownership with guard %s",
    async (expectedAccountId) => {
      const harness = responseHarness();
      const replace = vi.fn(async () => ({ envName: "REPORT_API_TOKEN", revision: 1 }));
      const service = {
        authenticate: vi.fn(async () => ({ user: { id: "user-b", accountId: "account-b" } })),
        replace,
      } as unknown as ExecCredentialService;
      await handlePlatformClawExecCredentialRequest(
        {
          url: "/platformclaw/api/exec-credentials",
          method: "POST",
          headers: { cookie: "platformclaw_session=synthetic" },
        } as IncomingMessage,
        harness.response,
        {
          service,
          readJsonBody: vi.fn(async () => ({
            ok: true as const,
            value: {
              action: "replace",
              envName: "REPORT_API_TOKEN",
              value: "synthetic-only",
              userId: "user-a",
              expectedAccountId,
            },
          })),
          isMutationOriginAllowed: () => true,
        },
      );
      expect(harness.response.statusCode).toBe(200);
      expect(replace).toHaveBeenCalledWith("user-b", "REPORT_API_TOKEN", "synthetic-only");
    },
  );

  it("unwraps the shared JSON reader result before validating an admin mutation", async () => {
    const addDefinition = vi.fn(async () => ({ definitions: [{ envName: "API_TOKEN" }] }));
    const service = {
      authenticate: vi.fn(async () => ({ user: { id: "admin-one" } })),
      addDefinition,
    } as unknown as ExecCredentialService;
    const harness = responseHarness();
    const readJsonBody = vi.fn(async () => ({
      ok: true as const,
      value: { action: "add", envName: "API_TOKEN" },
    }));

    await handlePlatformClawExecCredentialRequest(
      {
        url: "/platformclaw/api/admin/exec-credentials",
        method: "POST",
        headers: { cookie: "platformclaw_session=test-token" },
      } as IncomingMessage,
      harness.response,
      { service, readJsonBody, isMutationOriginAllowed: () => true },
    );

    expect(harness.response.statusCode).toBe(200);
    expect(harness.body()).toEqual({ definitions: [{ envName: "API_TOKEN" }] });
    expect(addDefinition).toHaveBeenCalledWith("admin-one", "API_TOKEN");
    expect(readJsonBody).toHaveBeenCalledWith(expect.anything(), 64 * 1024);
  });
});
