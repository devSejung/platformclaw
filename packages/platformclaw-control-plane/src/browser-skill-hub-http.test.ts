import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  handlePlatformClawSkillHubRequest,
  PLATFORMCLAW_SKILL_HUB_PATH,
} from "./browser-skill-hub-http.js";
import type { SkillHubService } from "./skill-hub-service.js";

function responseHarness() {
  let body = "";
  return {
    response: {
      statusCode: 200,
      setHeader: vi.fn(),
      end(value?: unknown) {
        body = typeof value === "string" ? value : "";
      },
    } as unknown as ServerResponse,
    json: () => JSON.parse(body) as unknown,
  };
}

const actor = {
  user: { id: "user-one", globalRole: "member", groups: ["engineering"] },
  agentId: "agent-one",
  workspaceDir: "/workspace/agent-one",
};

describe("Skill Hub browser HTTP", () => {
  it("requires the existing PlatformClaw session", async () => {
    const service = { authenticate: vi.fn(async () => null) } as unknown as SkillHubService;
    const harness = responseHarness();
    await handlePlatformClawSkillHubRequest(
      {
        url: `${PLATFORMCLAW_SKILL_HUB_PATH}/config`,
        method: "GET",
        headers: {},
      } as IncomingMessage,
      harness.response,
      { service, readJsonBody: vi.fn(), isMutationOriginAllowed: () => true },
    );
    expect(harness.response.statusCode).toBe(401);
    expect(harness.json()).toEqual({ error: "authentication required" });
  });

  it("returns only browser-safe configuration", async () => {
    const service = {
      authenticate: vi.fn(async () => actor),
      config: vi.fn(() => ({ namespaces: ["engineering"], maxPackageBytes: 1024 })),
    } as unknown as SkillHubService;
    const harness = responseHarness();
    await handlePlatformClawSkillHubRequest(
      {
        url: `${PLATFORMCLAW_SKILL_HUB_PATH}/config`,
        method: "GET",
        headers: { cookie: "platformclaw_session=session-token" },
      } as IncomingMessage,
      harness.response,
      { service, readJsonBody: vi.fn(), isMutationOriginAllowed: () => true },
    );
    expect(harness.json()).toEqual({ namespaces: ["engineering"], maxPackageBytes: 1024 });
    expect(JSON.stringify(harness.json())).not.toMatch(/token|authorization|url/iu);
  });

  it("rejects publish mutations from another origin before reading the body", async () => {
    const service = { authenticate: vi.fn(async () => actor) } as unknown as SkillHubService;
    const readJsonBody = vi.fn();
    const harness = responseHarness();
    await handlePlatformClawSkillHubRequest(
      {
        url: `${PLATFORMCLAW_SKILL_HUB_PATH}/publish`,
        method: "POST",
        headers: { cookie: "platformclaw_session=session-token" },
      } as IncomingMessage,
      harness.response,
      { service, readJsonBody, isMutationOriginAllowed: () => false },
    );
    expect(harness.response.statusCode).toBe(403);
    expect(readJsonBody).not.toHaveBeenCalled();
  });
});
