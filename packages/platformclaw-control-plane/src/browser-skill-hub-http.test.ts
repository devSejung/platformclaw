import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  handlePlatformClawSkillHubRequest,
  PLATFORMCLAW_SKILL_HUB_PATH,
} from "./browser-skill-hub-http.js";
import { ControlPlaneConflictError } from "./contracts.js";
import type { SkillHubService } from "./skill-hub-service.js";
import { SkillHubServiceError } from "./skill-hub-service.js";

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
  it("returns a bounded safe management-user projection", async () => {
    const searchManagementUsers = vi.fn(async () => ({
      items: [{ id: "opaque-user", accountId: "person.one", displayName: "Person One" }],
    }));
    const service = {
      authenticate: vi.fn(async () => actor),
      searchManagementUsers,
    } as unknown as SkillHubService;
    const harness = responseHarness();
    await handlePlatformClawSkillHubRequest(
      {
        url: `${PLATFORMCLAW_SKILL_HUB_PATH}/skills/engineering/demo/management-users?q=pe%25_&purpose=owner&limit=200`,
        method: "GET",
        headers: { cookie: "platformclaw_session=session-token" },
      } as IncomingMessage,
      harness.response,
      { service, readJsonBody: vi.fn(), isMutationOriginAllowed: () => true },
    );
    expect(searchManagementUsers).toHaveBeenCalledWith(
      actor.user,
      "engineering",
      "demo",
      "pe%_",
      "owner",
      200,
    );
    expect(harness.json()).toEqual({
      items: [{ id: "opaque-user", accountId: "person.one", displayName: "Person One" }],
    });
    expect(JSON.stringify(harness.json())).not.toMatch(/employeeId|email|groups|globalRole/iu);
  });

  it("maps authoritative binding conflicts to a safe 409", async () => {
    const service = {
      authenticate: vi.fn(async () => actor),
      setNamespaceBinding: vi.fn(async () => {
        throw new ControlPlaneConflictError(
          "skill_hub_namespace_binding_changed",
          "binding changed; reload and retry",
        );
      }),
    } as unknown as SkillHubService;
    const harness = responseHarness();
    await handlePlatformClawSkillHubRequest(
      {
        url: `${PLATFORMCLAW_SKILL_HUB_PATH}/admin/namespaces`,
        method: "POST",
        headers: { cookie: "platformclaw_session=session-token" },
      } as IncomingMessage,
      harness.response,
      {
        service,
        readJsonBody: vi.fn(async () => ({
          ok: true as const,
          value: {
            namespace: "engineering",
            scopeKind: "global",
            visibilityCeiling: "NAMESPACE_ONLY",
            expectedUpdatedAt: 1,
            reason: "reviewed change",
          },
        })),
        isMutationOriginAllowed: () => true,
      },
    );
    expect(harness.response.statusCode).toBe(409);
    expect(harness.json()).toEqual({
      error: "binding changed; reload and retry",
      details: { code: "skill_hub_namespace_binding_changed" },
    });
  });

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

  it("lists only the explicitly selected authenticated workspace without changing target", async () => {
    const workspaceSkills = vi.fn(async () => ({
      source: "assigned_vm",
      items: [{ skillKey: "demo-skill", version: "1.2.3" }],
    }));
    const service = {
      authenticate: vi.fn(async () => actor),
      workspaceSkills,
    } as unknown as SkillHubService;
    const harness = responseHarness();
    await handlePlatformClawSkillHubRequest(
      {
        url: `${PLATFORMCLAW_SKILL_HUB_PATH}/workspace-skills?source=assigned_vm`,
        method: "GET",
        headers: { cookie: "platformclaw_session=session-token" },
      } as IncomingMessage,
      harness.response,
      { service, readJsonBody: vi.fn(), isMutationOriginAllowed: () => true },
    );
    expect(workspaceSkills).toHaveBeenCalledWith(actor, "assigned_vm");
    expect(harness.json()).toEqual({
      source: "assigned_vm",
      items: [{ skillKey: "demo-skill", version: "1.2.3" }],
    });
  });

  it("rejects an unknown workspace publication source", async () => {
    const service = { authenticate: vi.fn(async () => actor) } as unknown as SkillHubService;
    const harness = responseHarness();
    await handlePlatformClawSkillHubRequest(
      {
        url: `${PLATFORMCLAW_SKILL_HUB_PATH}/workspace-skills?source=shared`,
        method: "GET",
        headers: { cookie: "platformclaw_session=session-token" },
      } as IncomingMessage,
      harness.response,
      { service, readJsonBody: vi.fn(), isMutationOriginAllowed: () => true },
    );
    expect(harness.response.statusCode).toBe(400);
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

  it("returns the structured version-change contract without leaking server state", async () => {
    const service = {
      authenticate: vi.fn(async () => actor),
      install: vi.fn(async () => {
        throw new SkillHubServiceError("confirm upgrade", 409, {
          code: "version-change-required",
          currentVersion: "1.0.0",
          requestedVersion: "2.0.0",
          direction: "upgrade",
        });
      }),
    } as unknown as SkillHubService;
    const harness = responseHarness();
    await handlePlatformClawSkillHubRequest(
      {
        url: `${PLATFORMCLAW_SKILL_HUB_PATH}/install`,
        method: "POST",
        headers: { cookie: "platformclaw_session=session-token" },
      } as IncomingMessage,
      harness.response,
      {
        service,
        readJsonBody: vi.fn(async () => ({
          ok: true as const,
          value: {
            namespace: "engineering",
            slug: "demo-skill",
            version: "2.0.0",
            destination: "platform_server",
          },
        })),
        isMutationOriginAllowed: () => true,
      },
    );

    expect(harness.response.statusCode).toBe(409);
    expect(harness.json()).toEqual({
      error: "confirm upgrade",
      details: {
        code: "version-change-required",
        currentVersion: "1.0.0",
        requestedVersion: "2.0.0",
        direction: "upgrade",
      },
    });
  });

  it.each([
    ["global", undefined],
    ["team", "team-one"],
  ] as const)("passes the canonical %s namespace scope shape", async (scopeKind, scopeId) => {
    const setNamespaceBinding = vi.fn(async () => ({ ok: true }));
    const service = {
      authenticate: vi.fn(async () => actor),
      setNamespaceBinding,
    } as unknown as SkillHubService;
    const harness = responseHarness();
    await handlePlatformClawSkillHubRequest(
      {
        url: `${PLATFORMCLAW_SKILL_HUB_PATH}/admin/namespaces`,
        method: "POST",
        headers: { cookie: "platformclaw_session=session-token" },
      } as IncomingMessage,
      harness.response,
      {
        service,
        readJsonBody: vi.fn(async () => ({
          ok: true as const,
          value: {
            namespace: "engineering",
            scopeKind,
            ...(scopeId ? { scopeId } : {}),
            visibilityCeiling: "NAMESPACE_ONLY",
            expectedUpdatedAt: null,
            reason: "organization rollout",
          },
        })),
        isMutationOriginAllowed: () => true,
      },
    );

    expect(harness.response.statusCode).toBe(200);
    expect(setNamespaceBinding).toHaveBeenCalledWith(actor.user, {
      namespace: "engineering",
      scopeKind,
      ...(scopeId ? { scopeId } : {}),
      visibilityCeiling: "NAMESPACE_ONLY",
      expectedUpdatedAt: null,
      reason: "organization rollout",
    });
  });

  it("pins Global activation to the session actor and an expected binding revision", async () => {
    const setNamespaceAccessState = vi.fn(async () => ({ accessState: "active" }));
    const service = {
      authenticate: vi.fn(async () => actor),
      setNamespaceAccessState,
    } as unknown as SkillHubService;
    const harness = responseHarness();
    await handlePlatformClawSkillHubRequest(
      {
        url: `${PLATFORMCLAW_SKILL_HUB_PATH}/admin/namespaces/company/access-state`,
        method: "POST",
        headers: { cookie: "platformclaw_session=session-token" },
      } as IncomingMessage,
      harness.response,
      {
        service,
        readJsonBody: vi.fn(async () => ({
          ok: true as const,
          value: {
            accessState: "active",
            expectedUpdatedAt: 42,
            reason: "approved organization-wide visibility",
            actorUserId: "forged-user",
          },
        })),
        isMutationOriginAllowed: () => true,
      },
    );

    expect(harness.response.statusCode).toBe(200);
    expect(setNamespaceAccessState).toHaveBeenCalledWith(actor.user, "company", {
      accessState: "active",
      expectedUpdatedAt: 42,
      reason: "approved organization-wide visibility",
    });
  });
});
