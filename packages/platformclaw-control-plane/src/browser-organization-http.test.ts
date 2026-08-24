import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserAuthService } from "./browser-auth-service.js";
import {
  BrowserOrganizationService,
  handlePlatformClawOrganizationRequest,
  PLATFORMCLAW_ORGANIZATION_PATH,
} from "./browser-organization-http.js";
import type { ControlPlaneIdFactory, EnterprisePrincipal, PlatformUser } from "./contracts.js";
import { OrganizationService } from "./organization-service.js";
import { SqliteControlPlaneStore } from "./sqlite-store.js";

const directories: string[] = [];
let sequence = 0;

function ids(): ControlPlaneIdFactory {
  const next = (kind: string) => `${kind}-${++sequence}`;
  return {
    nextUserId: () => next("user"),
    nextBindingId: () => next("binding"),
    nextSessionId: () => next("session"),
    nextManagedScopeId: () => next("scope"),
    nextAuditEventId: () => next("audit"),
  };
}

function principal(accountId: string, displayName = accountId): EnterprisePrincipal {
  return {
    provider: "ldap",
    subject: accountId,
    accountId,
    employeeId: `employee-${accountId}`,
    displayName,
    email: `${accountId}@example.test`,
    department: "Private department",
    groups: ["private-directory-group"],
  };
}

function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), "platformclaw-organization-http-"));
  directories.push(directory);
  const store = new SqliteControlPlaneStore({
    databasePath: join(directory, "control.sqlite"),
    buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
    initialAdminAccountIds: ["admin"],
    idFactory: ids(),
  });
  const users = new Map<string, PlatformUser>();
  let clock = 1_000;
  const authService = {
    authenticateToken: vi.fn(async (token: string) => {
      const user = users.get(token);
      return user ? { status: "active", user } : { status: "not-found" };
    }),
  } as unknown as BrowserAuthService;
  return {
    store,
    users,
    organization: new OrganizationService(store),
    service: new BrowserOrganizationService({
      authService,
      organization: new OrganizationService(store),
      now: () => clock++,
    }),
  };
}

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
    body: () => (responseBody ? (JSON.parse(responseBody) as unknown) : undefined),
  };
}

async function call(
  service: BrowserOrganizationService,
  params: {
    method?: string;
    path: string;
    token?: string;
    body?: Record<string, unknown>;
    originAllowed?: boolean;
    contentType?: string | null;
  },
) {
  const harness = responseHarness();
  const request = {
    url: params.path,
    method: params.method ?? "GET",
    headers: {
      ...(params.token ? { cookie: `platformclaw_session=${params.token}` } : {}),
      ...(params.contentType === null
        ? {}
        : { "content-type": params.contentType ?? "application/json" }),
    },
  } as unknown as IncomingMessage;
  await handlePlatformClawOrganizationRequest(request, harness.response, {
    service,
    isMutationOriginAllowed: () => params.originAllowed ?? true,
    readJsonBody: async () => ({ ok: true, value: params.body ?? {} }),
  });
  return { status: harness.response.statusCode, body: harness.body() };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("PlatformClaw organization browser API", () => {
  it("pins the actor to the active session and rejects malformed browser input", async () => {
    const fixture = createFixture();
    const admin = (await fixture.store.upsertPrincipal(principal("admin"), 1)).user;
    const member = (await fixture.store.upsertPrincipal(principal("member"), 2)).user;
    fixture.users.set("member-token", member);

    expect(
      await call(fixture.service, { path: `${PLATFORMCLAW_ORGANIZATION_PATH}/context` }),
    ).toMatchObject({ status: 401 });
    expect(
      await call(fixture.service, {
        path: `${PLATFORMCLAW_ORGANIZATION_PATH}/context?userId=${admin.id}`,
        token: "member-token",
      }),
    ).toMatchObject({ status: 400 });
    expect(
      await call(fixture.service, {
        method: "POST",
        path: `${PLATFORMCLAW_ORGANIZATION_PATH}/requests`,
        token: "member-token",
        contentType: "text/plain",
        body: { scopeId: "scope-one", reason: "join" },
      }),
    ).toMatchObject({ status: 415 });
    expect(
      await call(fixture.service, {
        method: "POST",
        path: `${PLATFORMCLAW_ORGANIZATION_PATH}/requests`,
        token: "member-token",
        originAllowed: false,
        body: { scopeId: "scope-one", reason: "join" },
      }),
    ).toMatchObject({ status: 403 });
    const injectedActor = await call(fixture.service, {
      method: "POST",
      path: `${PLATFORMCLAW_ORGANIZATION_PATH}/requests`,
      token: "member-token",
      contentType: "Application/JSON; charset=utf-8",
      body: { userId: admin.id, scopeId: "scope-one", reason: "join" },
    });
    expect(injectedActor).toMatchObject({ status: 400 });
    expect(
      await call(fixture.service, {
        path: `${PLATFORMCLAW_ORGANIZATION_PATH}/audit`,
        token: "member-token",
      }),
    ).toMatchObject({ status: 403 });
    fixture.store.close();
  });

  it("returns bounded identity-only scope search with literal wildcard semantics", async () => {
    const fixture = createFixture();
    const admin = (await fixture.store.upsertPrincipal(principal("admin"), 1)).user;
    const member = (await fixture.store.upsertPrincipal(principal("member"), 2)).user;
    fixture.users.set("member-token", member);
    const scope = await fixture.organization.createScope({
      actorUserId: admin.id,
      kind: "team",
      name: "Platform 100%",
      createdAt: 3,
    });

    const normal = await call(fixture.service, {
      path: `${PLATFORMCLAW_ORGANIZATION_PATH}/scopes?q=Platform&limit=10`,
      token: "member-token",
    });
    expect(normal).toMatchObject({
      status: 200,
      body: { items: [{ id: scope.id, name: "Platform 100%", requestEligible: true }] },
    });
    expect(JSON.stringify(normal.body)).not.toContain("createdByUserId");
    const blank = await call(fixture.service, {
      path: `${PLATFORMCLAW_ORGANIZATION_PATH}/scopes?limit=10`,
      token: "member-token",
    });
    expect(blank).toMatchObject({ status: 200, body: { items: [{ id: scope.id }] } });
    const wildcard = await call(fixture.service, {
      path: `${PLATFORMCLAW_ORGANIZATION_PATH}/scopes?q=_&limit=10`,
      token: "member-token",
    });
    expect(wildcard).toMatchObject({ status: 200, body: { items: [] } });
    const group = await fixture.organization.createScope({
      actorUserId: admin.id,
      kind: "group",
      parentScopeId: scope.id,
      name: "Runtime",
      createdAt: 4,
    });
    await fixture.organization.archiveScope({
      actorUserId: admin.id,
      scopeId: scope.id,
      reason: "archive lineage",
      archivedAt: 5,
    });
    const archivedLineage = await call(fixture.service, {
      path: `${PLATFORMCLAW_ORGANIZATION_PATH}/scopes?q=Runtime&limit=10`,
      token: "member-token",
    });
    expect(archivedLineage).toMatchObject({ status: 200, body: { items: [] } });
    expect(JSON.stringify(archivedLineage.body)).not.toContain(group.id);
    fixture.store.close();
  });

  it("shows safe context and paged own outcomes with immutable decision reasons", async () => {
    const fixture = createFixture();
    const admin = (await fixture.store.upsertPrincipal(principal("admin"), 1)).user;
    const member = (await fixture.store.upsertPrincipal(principal("member", "Member Name"), 2))
      .user;
    fixture.users.set("admin-token", admin);
    fixture.users.set("member-token", member);
    const team = await fixture.organization.createScope({
      actorUserId: admin.id,
      kind: "team",
      name: "Engineering",
      createdAt: 3,
    });
    const submitted = await call(fixture.service, {
      method: "POST",
      path: `${PLATFORMCLAW_ORGANIZATION_PATH}/requests`,
      token: "member-token",
      body: { scopeId: team.id, reason: "Please add me" },
    });
    const requestId = (submitted.body as { id: string }).id;
    await call(fixture.service, {
      method: "POST",
      path: `${PLATFORMCLAW_ORGANIZATION_PATH}/requests/${requestId}/decision`,
      token: "admin-token",
      body: { decision: "approved", reason: "Team need confirmed" },
    });
    expect(
      await call(fixture.service, {
        method: "POST",
        path: `${PLATFORMCLAW_ORGANIZATION_PATH}/requests/${requestId}/decision`,
        token: "admin-token",
        body: { decision: "approved", reason: "repeat" },
      }),
    ).toMatchObject({
      status: 409,
      body: { code: "organization_join_request_terminal_conflict" },
    });

    const context = await call(fixture.service, {
      path: `${PLATFORMCLAW_ORGANIZATION_PATH}/context`,
      token: "member-token",
    });
    expect(context).toMatchObject({
      status: 200,
      body: {
        actor: { id: member.id, displayName: "Member Name", isAdministrator: false },
        recentJoinRequests: [{ id: requestId, status: "approved" }],
      },
    });
    expect(JSON.stringify(context.body)).not.toContain("employee-member");
    expect(JSON.stringify(context.body)).not.toContain("@example.test");
    const history = await call(fixture.service, {
      path: `${PLATFORMCLAW_ORGANIZATION_PATH}/requests/own?limit=1&offset=0`,
      token: "member-token",
    });
    expect(history).toMatchObject({
      status: 200,
      body: { items: [{ id: requestId, decisionReason: "Team need confirmed" }] },
    });
    const secondTeam = await fixture.organization.createScope({
      actorUserId: admin.id,
      kind: "team",
      name: "Product",
      createdAt: 4,
    });
    await call(fixture.service, {
      method: "POST",
      path: `${PLATFORMCLAW_ORGANIZATION_PATH}/requests`,
      token: "member-token",
      body: { scopeId: secondTeam.id, reason: "Product collaboration" },
    });
    const firstPage = await call(fixture.service, {
      path: `${PLATFORMCLAW_ORGANIZATION_PATH}/requests/own?limit=1&offset=0`,
      token: "member-token",
    });
    expect(firstPage).toMatchObject({ status: 200, body: { nextOffset: 1 } });
    expect(
      await call(fixture.service, {
        path: `${PLATFORMCLAW_ORGANIZATION_PATH}/requests/own?limit=1&offset=1`,
        token: "member-token",
      }),
    ).toMatchObject({ status: 200, body: { items: [{ id: requestId }] } });
    fixture.store.close();
  });

  it("does not reveal foreign request state through arbitrary request identifiers", async () => {
    const fixture = createFixture();
    const admin = (await fixture.store.upsertPrincipal(principal("admin"), 1)).user;
    const leader = (await fixture.store.upsertPrincipal(principal("leader"), 2)).user;
    const applicant = (await fixture.store.upsertPrincipal(principal("applicant"), 3)).user;
    fixture.users.set("leader-token", leader);
    const firstTeam = await fixture.organization.createScope({
      actorUserId: admin.id,
      kind: "team",
      name: "First",
      createdAt: 4,
    });
    const secondTeam = await fixture.organization.createScope({
      actorUserId: admin.id,
      kind: "team",
      name: "Second",
      createdAt: 5,
    });
    await fixture.organization.assignMember({
      actorUserId: admin.id,
      scopeId: firstTeam.id,
      userId: leader.id,
      role: "leader",
      reason: "appoint",
      changedAt: 6,
    });
    const request = await fixture.organization.requestMembership({
      userId: applicant.id,
      scopeId: secondTeam.id,
      reason: "join second",
      submittedAt: 7,
    });
    const decide = (requestId: string) =>
      call(fixture.service, {
        method: "POST",
        path: `${PLATFORMCLAW_ORGANIZATION_PATH}/requests/${requestId}/decision`,
        token: "leader-token",
        body: { decision: "approved", reason: "probe" },
      });
    expect(await decide(request.id)).toEqual({
      status: 404,
      body: { error: "organization resource not found" },
    });
    expect(await decide("missing-request")).toEqual({
      status: 404,
      body: { error: "organization resource not found" },
    });
    fixture.store.close();
  });

  it("projects review, roster, and user search without private directory fields", async () => {
    const fixture = createFixture();
    const admin = (await fixture.store.upsertPrincipal(principal("admin"), 1)).user;
    const leader = (await fixture.store.upsertPrincipal(principal("leader", "Leader"), 2)).user;
    const applicant = (await fixture.store.upsertPrincipal(principal("applicant", "Applicant"), 3))
      .user;
    const outsider = (await fixture.store.upsertPrincipal(principal("outsider"), 4)).user;
    fixture.users.set("leader-token", leader);
    fixture.users.set("outsider-token", outsider);
    const team = await fixture.organization.createScope({
      actorUserId: admin.id,
      kind: "team",
      name: "Engineering",
      createdAt: 5,
    });
    await fixture.organization.assignMember({
      actorUserId: admin.id,
      scopeId: team.id,
      userId: leader.id,
      role: "leader",
      reason: "appoint",
      changedAt: 6,
    });
    await fixture.organization.requestMembership({
      userId: applicant.id,
      scopeId: team.id,
      reason: "join",
      submittedAt: 7,
    });

    const review = await call(fixture.service, {
      path: `${PLATFORMCLAW_ORGANIZATION_PATH}/requests/reviewable`,
      token: "leader-token",
    });
    expect(review).toMatchObject({
      status: 200,
      body: {
        items: [
          {
            applicant: { id: applicant.id, accountId: "applicant", displayName: "Applicant" },
            scope: { id: team.id, name: "Engineering" },
          },
        ],
      },
    });
    const users = await call(fixture.service, {
      path: `${PLATFORMCLAW_ORGANIZATION_PATH}/management/scopes/${team.id}/users?q=app&limit=10`,
      token: "leader-token",
    });
    expect(users).toMatchObject({
      status: 200,
      body: { items: [{ id: applicant.id, accountId: "applicant", displayName: "Applicant" }] },
    });
    expect(JSON.stringify(users.body)).not.toContain("@example.test");
    expect(
      await call(fixture.service, {
        path: `${PLATFORMCLAW_ORGANIZATION_PATH}/management/scopes/${team.id}/users?q=%25_`,
        token: "leader-token",
      }),
    ).toMatchObject({ status: 200, body: { items: [] } });
    await fixture.organization.assignMember({
      actorUserId: admin.id,
      scopeId: team.id,
      userId: outsider.id,
      role: "member",
      reason: "add member",
      changedAt: 8,
    });
    const roster = await call(fixture.service, {
      path: `${PLATFORMCLAW_ORGANIZATION_PATH}/management/scopes/${team.id}?limit=1&offset=0`,
      token: "leader-token",
    });
    expect(roster).toMatchObject({
      status: 200,
      body: {
        members: [{ user: { id: leader.id, accountId: "leader", displayName: "Leader" } }],
        nextOffset: 1,
      },
    });
    expect(JSON.stringify(roster.body)).not.toContain("@example.test");
    expect(
      await call(fixture.service, {
        path: `${PLATFORMCLAW_ORGANIZATION_PATH}/management/scopes/${team.id}?limit=1&offset=1`,
        token: "leader-token",
      }),
    ).toMatchObject({ status: 200, body: { members: [{ user: { id: outsider.id } }] } });
    expect(
      await call(fixture.service, {
        path: `${PLATFORMCLAW_ORGANIZATION_PATH}/management/scopes/${team.id}/users?q=app`,
        token: "outsider-token",
      }),
    ).toMatchObject({ status: 403 });
    fixture.store.close();
  });

  it("keeps leader and administrator mutation capabilities distinct", async () => {
    const fixture = createFixture();
    const admin = (await fixture.store.upsertPrincipal(principal("admin"), 1)).user;
    const leader = (await fixture.store.upsertPrincipal(principal("leader"), 2)).user;
    const member = (await fixture.store.upsertPrincipal(principal("member"), 3)).user;
    fixture.users.set("admin-token", admin);
    fixture.users.set("leader-token", leader);
    const team = await fixture.organization.createScope({
      actorUserId: admin.id,
      kind: "team",
      name: "Engineering",
      createdAt: 4,
    });
    await fixture.organization.assignMember({
      actorUserId: admin.id,
      scopeId: team.id,
      userId: leader.id,
      role: "leader",
      reason: "appoint",
      changedAt: 5,
    });
    expect(
      await call(fixture.service, {
        method: "POST",
        path: `${PLATFORMCLAW_ORGANIZATION_PATH}/memberships`,
        token: "leader-token",
        body: { scopeId: team.id, userId: member.id, role: "member", reason: "add member" },
      }),
    ).toMatchObject({ status: 200 });
    expect(
      await call(fixture.service, {
        method: "POST",
        path: `${PLATFORMCLAW_ORGANIZATION_PATH}/memberships`,
        token: "leader-token",
        body: { scopeId: team.id, userId: member.id, role: "leader", reason: "appoint" },
      }),
    ).toMatchObject({ status: 403 });
    expect(
      await call(fixture.service, {
        method: "POST",
        path: `${PLATFORMCLAW_ORGANIZATION_PATH}/memberships`,
        token: "admin-token",
        body: { scopeId: team.id, userId: member.id, role: "leader", reason: "appoint" },
      }),
    ).toMatchObject({ status: 200 });
    fixture.store.close();
  });

  it("supports admin scope create, idempotent rename, and archive with safe projections", async () => {
    const fixture = createFixture();
    const admin = (await fixture.store.upsertPrincipal(principal("admin"), 1)).user;
    fixture.users.set("admin-token", admin);
    expect(
      await call(fixture.service, {
        method: "POST",
        path: `${PLATFORMCLAW_ORGANIZATION_PATH}/scopes`,
        token: "admin-token",
        body: { kind: "team", name: "Invalid", parentScopeId: "scope-parent" },
      }),
    ).toMatchObject({ status: 400 });
    const created = await call(fixture.service, {
      method: "POST",
      path: `${PLATFORMCLAW_ORGANIZATION_PATH}/scopes`,
      token: "admin-token",
      body: { kind: "team", name: "Engineering" },
    });
    const scopeId = (created.body as { id: string }).id;
    await fixture.organization.assignMember({
      actorUserId: admin.id,
      scopeId,
      userId: admin.id,
      role: "leader",
      reason: "admin primary scope",
      changedAt: 2,
    });
    const primary = await call(fixture.service, {
      method: "PUT",
      path: `${PLATFORMCLAW_ORGANIZATION_PATH}/primary`,
      token: "admin-token",
      body: { scopeId },
    });
    expect(primary).toMatchObject({ status: 200, body: { id: scopeId } });
    expect(JSON.stringify(primary.body)).not.toContain("createdByUserId");
    const rename = () =>
      call(fixture.service, {
        method: "PATCH",
        path: `${PLATFORMCLAW_ORGANIZATION_PATH}/scopes/${scopeId}`,
        token: "admin-token",
        body: { action: "rename", name: "Engineering", reason: "confirm name" },
      });
    expect(await rename()).toMatchObject({ status: 200, body: { name: "Engineering" } });
    expect(await rename()).toMatchObject({ status: 200, body: { name: "Engineering" } });
    expect(JSON.stringify((await rename()).body)).not.toContain("createdByUserId");
    expect(
      await call(fixture.service, {
        method: "PATCH",
        path: `${PLATFORMCLAW_ORGANIZATION_PATH}/scopes/${scopeId}`,
        token: "admin-token",
        body: { action: "archive", reason: "retire team" },
      }),
    ).toMatchObject({ status: 200, body: { status: "archived" } });
    expect(await rename()).toMatchObject({ status: 400 });
    const audit = await call(fixture.service, {
      path: `${PLATFORMCLAW_ORGANIZATION_PATH}/audit?limit=10`,
      token: "admin-token",
    });
    expect(audit).toMatchObject({ status: 200, body: { items: expect.any(Array) } });
    expect(JSON.stringify(audit.body)).not.toContain("details");
    expect(JSON.stringify(audit.body)).not.toContain("denialReason");
    fixture.store.close();
  });
});
