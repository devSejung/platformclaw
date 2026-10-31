import { afterEach, describe, expect, it } from "vitest";
import { PLATFORMCLAW_ORGANIZATION_PATH } from "./browser-organization-http.js";
import {
  call,
  cleanupOrganizationHttpFixtures,
  createFixture,
  principal,
} from "./browser-organization-http.test-support.js";

afterEach(cleanupOrganizationHttpFixtures);

describe("PlatformClaw directory organization browser API", () => {
  it("projects the actual one-Part lineage before a directory parent mapping is available", async () => {
    const fixture = createFixture();
    try {
      const admin = (await fixture.store.upsertPrincipal(principal("admin"), 1)).user;
      const member = (await fixture.store.upsertPrincipal(principal("member"), 2)).user;
      fixture.users.set("admin-token", admin);
      fixture.users.set("member-token", member);
      const result = await fixture.store.syncDirectoryOrganization({
        userId: member.id,
        org: {
          version: 1,
          source: "aicm",
          team: null,
          group: null,
          part: { id: "unmapped", name: "Runtime" },
          updatedAt: "2026-10-20T01:00:00Z",
        },
        isTestAccount: false,
        syncedAt: 10,
      });
      expect(result.status).toBe("synced");
      const scopes = await call(fixture.service, {
        path: `${PLATFORMCLAW_ORGANIZATION_PATH}/scopes?q=Runtime&limit=10`,
        token: "admin-token",
      });
      expect(scopes).toMatchObject({
        status: 200,
        body: {
          items: [
            {
              kind: "part",
              managedBy: "ldap-login",
              externalKey: "aicm-part:unmapped",
              lineage: [{ kind: "part", name: "Runtime" }],
              capabilities: { canManageMembers: true, canManageStructure: false },
            },
          ],
        },
      });
      expect(
        await call(fixture.service, {
          path: `${PLATFORMCLAW_ORGANIZATION_PATH}/context`,
          token: "member-token",
        }),
      ).toMatchObject({
        status: 200,
        body: {
          isUnaffiliated: false,
          directScopeLineages: [{ lineage: [{ kind: "part", name: "Runtime" }] }],
        },
      });
      expect(
        (
          await call(fixture.service, {
            path: `${PLATFORMCLAW_ORGANIZATION_PATH}/context`,
            token: "admin-token",
          })
        ).body,
      ).toMatchObject({ isUnaffiliated: true });
      await fixture.store.syncDirectoryOrganization({
        userId: admin.id,
        org: {
          version: 1,
          source: "aicm",
          team: null,
          group: null,
          part: { id: "unmapped", name: "Runtime" },
          updatedAt: "2026-10-20T01:00:00Z",
        },
        isTestAccount: false,
        syncedAt: 11,
      });
      expect(
        (
          await call(fixture.service, {
            path: `${PLATFORMCLAW_ORGANIZATION_PATH}/context`,
            token: "admin-token",
          })
        ).body,
      ).toMatchObject({
        actor: { isAdministrator: true },
        isUnaffiliated: false,
        effectiveScopes: [{ source: "administrator" }],
        directScopeLineages: [{ lineage: [{ kind: "part", name: "Runtime" }] }],
      });
    } finally {
      fixture.store.close();
    }
  });

  it("projects directory identity and provenance while rejecting automatic scope edits", async () => {
    const fixture = createFixture();
    try {
      const admin = (await fixture.store.upsertPrincipal(principal("admin"), 1)).user;
      const member = (await fixture.store.upsertPrincipal(principal("member"), 2)).user;
      const sibling = (await fixture.store.upsertPrincipal(principal("sibling"), 3)).user;
      fixture.users.set("admin-token", admin);
      fixture.users.set("member-token", member);
      const org = {
        version: 1,
        source: "aicm",
        team: "Platform",
        group: { id: "runtime", name: "Runtime" },
        part: { id: "sdk-one", name: "SDK" },
        updatedAt: "2026-10-20T01:00:00Z",
      };
      const first = await fixture.store.syncDirectoryOrganization({
        userId: member.id,
        org,
        isTestAccount: false,
        syncedAt: 10,
      });
      const second = await fixture.store.syncDirectoryOrganization({
        userId: sibling.id,
        org: { ...org, part: { id: "sdk-two", name: "SDK" } },
        isTestAccount: false,
        syncedAt: 11,
      });
      expect(first.status).toBe("synced");
      expect(second.status).toBe("synced");
      if (first.status !== "synced" || second.status !== "synced") {
        throw new Error("directory fixtures were not synchronized");
      }
      const scopes = await call(fixture.service, {
        path: `${PLATFORMCLAW_ORGANIZATION_PATH}/scopes?q=SDK&limit=10`,
        token: "admin-token",
      });
      expect(scopes).toMatchObject({
        status: 200,
        body: {
          items: expect.arrayContaining([
            expect.objectContaining({ id: first.scopeId, externalKey: "aicm-part:sdk-one" }),
            expect.objectContaining({ id: second.scopeId, externalKey: "aicm-part:sdk-two" }),
          ]),
        },
      });
      for (const scope of (scopes.body as { items: Array<Record<string, unknown>> }).items) {
        expect(scope).toMatchObject({
          managedBy: "ldap-login",
          capabilities: {
            canManageMembers: true,
            canManageStructure: false,
            canManageLeaders: true,
          },
          lineage: [
            { name: "Platform", externalKey: "team:Platform" },
            { name: "Runtime", externalKey: "group:runtime" },
            { name: "SDK" },
          ],
        });
      }
      const scope = await fixture.organization.getScope(first.scopeId);
      for (const action of ["rename", "archive"] as const) {
        const rejected = await call(fixture.service, {
          method: "PATCH",
          path: `${PLATFORMCLAW_ORGANIZATION_PATH}/scopes/${first.scopeId}`,
          token: "admin-token",
          body: {
            action,
            expectedRevision: scope!.updatedAt,
            reason: "admin attempt",
            ...(action === "rename" ? { name: "Manual name" } : {}),
          },
        });
        expect(rejected.status).toBeGreaterThanOrEqual(400);
        expect(rejected.status).toBeLessThan(500);
      }
      expect(await fixture.organization.getScope(first.scopeId)).toMatchObject({
        name: "SDK",
        status: "active",
      });
      expect(
        await call(fixture.service, {
          path: `${PLATFORMCLAW_ORGANIZATION_PATH}/context`,
          token: "member-token",
        }),
      ).toMatchObject({
        status: 200,
        body: { directMemberships: [{ scopeId: first.scopeId, managedBy: "ldap-login" }] },
      });
      expect(
        await call(fixture.service, {
          method: "POST",
          path: `${PLATFORMCLAW_ORGANIZATION_PATH}/memberships`,
          token: "admin-token",
          body: {
            scopeId: first.scopeId,
            userId: member.id,
            role: "member",
            expectedRole: "member",
            reason: "retain project access",
          },
        }),
      ).toMatchObject({ status: 200 });
      expect(
        await call(fixture.service, {
          path: `${PLATFORMCLAW_ORGANIZATION_PATH}/management/scopes/${first.scopeId}?limit=10`,
          token: "admin-token",
        }),
      ).toMatchObject({
        status: 200,
        body: {
          scope: { managedBy: "ldap-login", externalKey: "aicm-part:sdk-one" },
          members: [{ role: "member", managedBy: "ldap-login", manualRole: "member" }],
        },
      });
    } finally {
      fixture.store.close();
    }
  });
});
