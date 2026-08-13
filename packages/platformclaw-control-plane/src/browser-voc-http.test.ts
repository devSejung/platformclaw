import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { BrowserAuthService } from "./browser-auth-service.js";
import {
  handlePlatformClawVocRequest,
  JiraVocService,
  PLATFORMCLAW_VOC_API_PATH,
} from "./browser-voc-http.js";

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

function service(fetchImpl: typeof fetch) {
  const authService = {
    authenticateToken: vi.fn(async () => ({
      status: "active",
      user: {
        id: "user-one",
        accountId: "person.one",
        employeeId: "1001",
        displayName: "Person One",
      },
    })),
  } as unknown as BrowserAuthService;
  return new JiraVocService({
    authService,
    fetchImpl,
    config: {
      baseUrl: "https://jira.company.example",
      projectKey: "VOC",
      parentIssueKey: "VOC-1",
      issueType: "Task",
      assignee: "voc.owner",
      components: ["PlatformClaw"],
      coworkerField: "customfield_12345",
      defaultCoworkers: ["voc.watcher"],
      authorization: "Bearer secret",
    },
  });
}

describe("PlatformClaw VOC HTTP", () => {
  it("creates a Jira issue with authenticated reporter metadata", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ key: "VOC-42" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const harness = responseHarness();

    await handlePlatformClawVocRequest(
      {
        url: PLATFORMCLAW_VOC_API_PATH,
        method: "POST",
        headers: { cookie: "platformclaw_session=test-token" },
      } as IncomingMessage,
      harness.response,
      {
        service: service(fetchImpl),
        isMutationOriginAllowed: () => true,
        readJsonBody: async () => ({
          ok: true,
          value: { title: "Improve onboarding", description: "Add a short example." },
        }),
      },
    );

    expect(harness.response.statusCode).toBe(201);
    expect(harness.body()).toEqual({
      ok: true,
      issueKey: "VOC-42",
      issueUrl: "https://jira.company.example/browse/VOC-42",
    });
    const request = fetchImpl.mock.calls[0]?.[1];
    expect(request?.headers).toMatchObject({ Authorization: "Bearer secret" });
    const requestBody = request?.body;
    expect(typeof requestBody).toBe("string");
    if (typeof requestBody !== "string") {
      throw new Error("Expected Jira request body to be JSON text");
    }
    const payload = JSON.parse(requestBody) as { fields: Record<string, unknown> };
    expect(payload.fields).toMatchObject({
      project: { key: "VOC" },
      parent: { key: "VOC-1" },
      summary: "[VOC] Improve onboarding",
      description: "Add a short example.\n\n---\nReporter: Person One (1001)",
      components: [{ name: "PlatformClaw" }],
      customfield_12345: [{ name: "voc.watcher" }, { name: "voc.owner" }, { name: "1001" }],
    });
  });

  it("requires same-origin authenticated requests before contacting Jira", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const harness = responseHarness();
    await handlePlatformClawVocRequest(
      {
        url: PLATFORMCLAW_VOC_API_PATH,
        method: "POST",
        headers: { cookie: "platformclaw_session=test-token" },
      } as IncomingMessage,
      harness.response,
      {
        service: service(fetchImpl),
        isMutationOriginAllowed: () => false,
        readJsonBody: vi.fn(),
      },
    );
    expect(harness.response.statusCode).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
