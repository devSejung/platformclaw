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
