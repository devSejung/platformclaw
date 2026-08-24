import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { BrowserAuthService } from "./browser-auth-service.js";
import {
  BrowserOrganizationService,
  handlePlatformClawOrganizationRequest,
  PLATFORMCLAW_ORGANIZATION_PATH,
} from "./browser-organization-http.js";
import type { ControlPlaneIdFactory, EnterprisePrincipal, PlatformUser } from "./contracts.js";
import { OrganizationService } from "./organization-service.js";
import { SqliteControlPlaneStore } from "./sqlite-store.js";

function principal(accountId: string): EnterprisePrincipal {
  return {
    provider: "ldap",
    subject: accountId,
    accountId,
    employeeId: `employee-${accountId}`,
    displayName: accountId,
    groups: [],
  };
}

describe("PlatformClaw organization audit browser API", () => {
  it("uses stable filtered seek pagination, safe unknown actions, and current admin authority", async () => {
    const directory = mkdtempSync(join(tmpdir(), "platformclaw-organization-audit-http-"));
    let sequence = 0;
    const next = (kind: string) => `${kind}-${++sequence}`;
    const idFactory: ControlPlaneIdFactory = {
      nextUserId: () => next("user"),
      nextBindingId: () => next("binding"),
      nextSessionId: () => next("session"),
      nextManagedScopeId: () => next("scope"),
      nextAuditEventId: () => next("audit"),
    };
    const store = new SqliteControlPlaneStore({
      databasePath: join(directory, "control.sqlite"),
      buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
      initialAdminAccountIds: ["admin"],
      idFactory,
    });
    try {
      const admin = (await store.upsertPrincipal(principal("admin"), 1)).user;
      const auditor = (await store.upsertPrincipal(principal("auditor"), 2)).user;
      const promoted = await store.setUserGlobalRole({
        actorUserId: admin.id,
        targetUserId: auditor.id,
        role: "admin",
        changedAt: 3,
      });
      const users = new Map<string, PlatformUser>([["auditor-token", promoted]]);
      const authService = {
        authenticateToken: vi.fn(async (token: string) => {
          const user = users.get(token);
          return user ? { status: "active", user } : { status: "not-found" };
        }),
      } as unknown as BrowserAuthService;
      const service = new BrowserOrganizationService({
        authService,
        organization: new OrganizationService(store),
      });
      const call = async (query: string) => {
        let body = "";
        const response = {
          statusCode: 200,
          setHeader: vi.fn(),
          end: (value?: unknown) => {
            body = typeof value === "string" ? value : "";
          },
        } as unknown as ServerResponse;
        await handlePlatformClawOrganizationRequest(
          {
            url: `${PLATFORMCLAW_ORGANIZATION_PATH}/audit${query}`,
            method: "GET",
            headers: { cookie: "platformclaw_session=auditor-token" },
          } as unknown as IncomingMessage,
          response,
          {
            service,
            isMutationOriginAllowed: () => true,
            readJsonBody: async () => ({ ok: true, value: {} }),
          },
        );
        return { status: response.statusCode, body: JSON.parse(body) as Record<string, unknown> };
      };
      for (const targetId of ["scope-a", "scope-b", "scope-c"]) {
        await store.recordAuditEvent({
          actorUserId: admin.id,
          eventType: "scope.rename.denied",
          targetType: "managed-scope",
          targetId,
          details: { outcome: "denied", reason: "stale structure" },
          createdAt: 9_000,
        });
      }
      const first = await call("?limit=2&category=scope&outcome=denied");
      const firstBody = first.body as {
        items: Array<{ key: string; action: string }>;
        nextCursor: string;
      };
      expect(firstBody.items).toHaveLength(2);
      expect(firstBody.items.every((item) => item.action === "scope.renamed")).toBe(true);
      await store.recordAuditEvent({
        actorUserId: admin.id,
        eventType: "scope.archive.denied",
        targetType: "managed-scope",
        targetId: "scope-new",
        details: { outcome: "denied" },
        createdAt: 10_000,
      });
      const second = await call(
        `?limit=2&category=scope&outcome=denied&cursor=${firstBody.nextCursor}`,
      );
      const secondItems = (second.body as { items: Array<{ key: string }> }).items;
      expect(secondItems).toHaveLength(1);
      expect(new Set([...firstBody.items, ...secondItems].map((item) => item.key)).size).toBe(3);

      await store.recordAuditEvent({
        actorUserId: admin.id,
        eventType: "scope.future-internal-action",
        targetType: "managed-scope",
        targetId: "scope-other",
        details: { outcome: "succeeded", denialReason: "private internal reason" },
        createdAt: 12_000,
      });
      const other = await call("?category=other");
      expect(other).toMatchObject({
        status: 200,
        body: { items: [{ action: "organization.other", category: "other" }] },
      });
      expect(JSON.stringify(other.body)).not.toContain("future-internal-action");
      expect(JSON.stringify(other.body)).not.toContain("private internal reason");

      await store.setUserGlobalRole({
        actorUserId: admin.id,
        targetUserId: auditor.id,
        role: "member",
        changedAt: 11_000,
      });
      expect(await call("")).toMatchObject({ status: 403 });
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
