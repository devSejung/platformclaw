import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { hashBrowserSessionToken } from "./browser-auth-service.js";
import type { GatewayAdminRpc } from "./gateway-admin-rpc-client.js";
import { GatewayPersonalAgentProvisioner } from "./personal-agent-provisioner.js";
import {
  createPlatformClawWebIngressRuntime,
  type PlatformClawWebIngressRuntime,
} from "./web-ingress-runtime.js";

const NOW = Date.parse("2026-10-30T01:00:00Z");
const ORIGIN = "http://127.0.0.1:3000";
const SSO_SECRET = "verified-directory-recovery-test-secret";
const SSO_REFRESH_URL =
  "/employee/auth/adsso?returnTo=%2Fplatformclaw%2Fapp%2Fsettings%2Forganization";
const SOURCE_ORGANIZATION = {
  version: 1,
  source: "aicm",
  updatedAt: "2026-10-30T00:00:00Z",
  team: "Engineering",
  group: { id: "platform", name: "Platform" },
  part: { id: "agents", name: "Agents" },
};

async function fixture(ssoConfigured = true) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "platformclaw-directory-backfill-")));
  const controlUiRoot = join(directory, "ui");
  mkdirSync(join(controlUiRoot, "assets"), { recursive: true });
  writeFileSync(join(controlUiRoot, "platformclaw-login.html"), "<!doctype html>Login");
  writeFileSync(
    join(controlUiRoot, "index.html"),
    '<!doctype html><html><head><title>Control</title><link href="./favicon.svg"><link href="./favicon-32.png"><link href="./apple-touch-icon.png"><link href="./manifest.webmanifest"></head><body>App</body></html>',
  );
  writeFileSync(join(controlUiRoot, "manifest.webmanifest"), "{}");
  writeFileSync(join(controlUiRoot, "assets", "platformclaw-pixel-test.svg"), "<svg></svg>");
  writeFileSync(
    join(controlUiRoot, "sw.js"),
    [
      'if (url.pathname.startsWith("/api/") || false) {}',
      'data = { title: "OpenClaw", body: event.data.text() };',
      'const title = data.title || "OpenClaw";',
      'const options = { icon: "./apple-touch-icon.png", badge: "./favicon-32.png", };',
    ].join("\n"),
  );

  let loginOrg: unknown = SOURCE_ORGANIZATION;
  let isTestAccount = false;
  let now = NOW;
  let nextProfileSeed: { entered(): void; wait: Promise<void> } | undefined;
  const authRequests: string[] = [];
  const server = createServer((request, response) => {
    authRequests.push(`${request.method} ${request.url}`);
    request.resume();
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/login" && request.method === "POST") {
      response.end(
        JSON.stringify({
          authenticated: true,
          employeeId: "employee-1",
          accountId: "person.one",
          org: loginOrg,
          isTestAccount,
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const employeeOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const rpc: GatewayAdminRpc = {
    async call<T>(method: string, raw: unknown): Promise<T> {
      const params = raw as { agentId: string; workspace: string };
      if (method === "platformclaw.agent.configStatus") {
        return { ok: true, configured: true, matches: true, ...params } as T;
      }
      if (method === "platformclaw.profile.status") {
        return { ok: true, status: "matched", ...params } as T;
      }
      if (method === "platformclaw.profile.seed") {
        const gate = nextProfileSeed;
        nextProfileSeed = undefined;
        if (gate) {
          gate.entered();
          await gate.wait;
        }
        return { ok: true, created: true, ...params } as T;
      }
      throw new Error(`unexpected Gateway boundary call: ${method}`);
    },
  };
  const createRuntime = () => {
    const provisioner = new GatewayPersonalAgentProvisioner({
      rpc,
      workspaceRoot: join(directory, "workspaces"),
    });
    return createPlatformClawWebIngressRuntime({
      databasePath: join(directory, "control.sqlite"),
      controlUiRoot,
      initialAdminAccountIds: ["admin.user"],
      buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
      resolveAgentIdFromSessionKey: (key) => /^agent:([^:]+):/.exec(key)?.[1] ?? null,
      provisioner,
      restartRecoveryProbe: provisioner,
      publicOrigin: ORIGIN,
      adminRpc: rpc,
      ...(ssoConfigured
        ? {
            employeeSso: { loginUrl: "https://auth.example.test/adsso", handoffSecret: SSO_SECRET },
          }
        : {}),
      employeeAuth: {
        employeeAuthConfig: {
          loginUrl: `${employeeOrigin}/login`,
          bearerToken: "test-directory-service-token",
        },
        now: () => now,
      },
      gatewayClient: {
        client: { url: "ws://127.0.0.1:18789", token: "test-gateway-token" },
        createClient: () => ({
          start() {},
          stop() {},
          async request() {
            return {};
          },
        }),
      },
    });
  };
  return {
    createRuntime,
    databasePath: join(directory, "control.sqlite"),
    authRequests,
    setLogin(org: unknown, testAccount = false) {
      loginOrg = org;
      isTestAccount = testAccount;
    },
    setNow(value: number) {
      now = value;
    },
    deferNextProfileSeed() {
      let entered = () => {};
      let release = () => {};
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      nextProfileSeed = { entered, wait };
      return { started, release };
    },
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function listen(runtime: PlatformClawWebIngressRuntime) {
  await runtime.listen({ host: "127.0.0.1", port: 0 });
  return `http://127.0.0.1:${(runtime.server.address() as AddressInfo).port}`;
}

async function assertExistingCookie(baseUrl: string, cookie: string, accountId = "person.one") {
  const session = await fetch(`${baseUrl}/platformclaw/api/auth/session`, {
    headers: { Cookie: cookie },
  });
  expect(await session.json()).toMatchObject({
    authenticated: true,
    user: { accountId },
  });
  const response = await fetch(`${baseUrl}/platformclaw/api/organization/context`, {
    headers: { Cookie: cookie },
  });
  expect(response.status).toBe(200);
  const context = await response.json();
  expect(context).toMatchObject({
    isUnaffiliated: false,
    directorySync: { status: "synced" },
    joinPromptEligible: false,
    directMemberships: [{ managedBy: "ldap-login", role: "member" }],
    directScopeLineages: [
      {
        lineage: [
          { kind: "team", name: "Engineering" },
          { kind: "group", name: "Platform" },
          { kind: "part", name: "Agents" },
        ],
      },
    ],
  });
  expect(context.directMemberships).toHaveLength(1);
}

describe("existing-session directory organization backfill", () => {
  it.each([true, false])(
    "keeps a legacy cookie usable with an explicit recovery action only when SSO is configured: %s",
    async (ssoConfigured) => {
      const setup = await fixture(ssoConfigured);
      let runtime: PlatformClawWebIngressRuntime | undefined;
      try {
        runtime = setup.createRuntime();
        // A pre-upgrade cookie contains identity, not a trusted organization claim.
        const { user } = await runtime.auth.store.upsertPrincipal(
          {
            provider: "ldap",
            subject: "person.one",
            accountId: "person.one",
            employeeId: "employee-1",
          },
          NOW - 1_000,
        );
        const { binding } = await runtime.auth.store.reservePersonalAgent(user.id, NOW - 900);
        await runtime.auth.store.transitionAgent({
          bindingId: binding.id,
          state: "active",
          changedAt: NOW - 800,
        });
        await runtime.auth.store.createBrowserSession({
          userId: user.id,
          tokenHash: hashBrowserSessionToken("pre-upgrade-cookie"),
          createdAt: NOW - 700,
        });
        expect(await runtime.auth.store.listManagedScopes()).toEqual([]);
        await runtime.close();
        runtime = setup.createRuntime();
        await runtime.prepare();
        expect(runtime.server.address()).toBeNull();
        const baseUrl = await listen(runtime);
        const cookie = "platformclaw_session=pre-upgrade-cookie";
        const session = await fetch(`${baseUrl}/platformclaw/api/auth/session`, {
          headers: { Cookie: cookie },
        });
        expect(await session.json()).toMatchObject({ authenticated: true });
        for (let count = 0; count < 2; count += 1) {
          const response = await fetch(`${baseUrl}/platformclaw/api/organization/context`, {
            headers: { Cookie: cookie },
          });
          const context = await response.json();
          expect(context).toMatchObject({
            isUnaffiliated: true,
            joinPromptEligible: false,
            directorySync: { status: "skipped", reason: "requires-authenticated-org" },
          });
          expect(context.directorySync.refreshUrl).toBe(
            ssoConfigured ? SSO_REFRESH_URL : undefined,
          );
        }
        expect(setup.authRequests).toEqual([]);
        expect(await runtime.auth.store.listManagedScopes()).toEqual([]);
      } finally {
        await runtime?.close();
        await setup.close();
      }
    },
  );

  it.each([
    { name: "restart", parentless: false, refresh: false },
    { name: "same-revision unknown Team", parentless: false, refresh: true },
    { name: "same-revision unknown Group", parentless: true, refresh: true },
  ])("recovers the selected authenticated fact after sync failure: $name", async (claim) => {
    const setup = await fixture();
    const initialOrg = claim.parentless
      ? { ...SOURCE_ORGANIZATION, team: null }
      : SOURCE_ORGANIZATION;
    setup.setLogin(initialOrg);
    let runtime: PlatformClawWebIngressRuntime | undefined;
    try {
      runtime = setup.createRuntime();
      const failedSync = vi
        .spyOn(runtime.auth.store, "syncDirectoryOrganization")
        .mockRejectedValueOnce(new Error("injected organization write failure"));
      const baseUrl = await listen(runtime);
      const login = (cookie?: string) =>
        fetch(`${baseUrl}/platformclaw/api/auth/login`, {
          method: "POST",
          headers: {
            Origin: ORIGIN,
            "Content-Type": "application/json",
            ...(cookie ? { Cookie: cookie } : {}),
          },
          body: JSON.stringify({ identifier: "person.one", password: "test-password" }),
        });
      const first = await login();
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({ authenticated: true });
      expect(failedSync).toHaveBeenCalledOnce();
      const cookie = first.headers.get("set-cookie")!.split(";", 1)[0]!;
      expect(await runtime.auth.store.listManagedScopes()).toEqual([]);
      failedSync.mockRestore();
      if (claim.refresh) {
        setup.setLogin({
          ...SOURCE_ORGANIZATION,
          ...(claim.parentless ? { group: null } : { team: null }),
        });
        const refreshed = await login(cookie);
        expect(refreshed.status).toBe(200);
        expect(refreshed.headers.get("set-cookie")!.split(";", 1)[0]).toBe(cookie);
        const user = (await runtime.auth.store.getUserByAccountId("person.one"))!;
        expect(await runtime.auth.store.getEmployeeDirectorySnapshot(user.id)).toEqual({
          org: { ...initialOrg, updatedAt: "2026-10-30T00:00:00.000Z" },
          isTestAccount: false,
        });
        // Inspect the graph before context recovery: login must apply the selected
        // fact rather than the weaker incoming claim or an inferred Group-Team edge.
        const scopes = await runtime.auth.store.listManagedScopes();
        expect(scopes).toHaveLength(claim.parentless ? 1 : 3);
        const part = scopes.find((scope) => scope.kind === "part")!;
        expect(part.parentScopeId).toBe(
          claim.parentless ? undefined : scopes.find((scope) => scope.kind === "group")!.id,
        );
        const database = new DatabaseSync(setup.databasePath);
        try {
          expect(
            database
              .prepare("SELECT directory_parent_key FROM managed_scopes WHERE id=?")
              .get(part.id),
          ).toMatchObject({ directory_parent_key: "group:platform" });
        } finally {
          database.close();
        }
      }
      await runtime.close();
      runtime = setup.createRuntime();
      const restarted = await listen(runtime);
      if (claim.parentless) {
        const response = await fetch(`${restarted}/platformclaw/api/organization/context`, {
          headers: { Cookie: cookie },
        });
        expect(await response.json()).toMatchObject({
          directorySync: { status: "synced" },
          directScopeLineages: [{ lineage: [{ kind: "part", name: "Agents" }] }],
        });
      } else {
        await assertExistingCookie(restarted, cookie);
        await assertExistingCookie(restarted, cookie);
      }
      expect(await runtime.auth.store.listManagedScopes()).toHaveLength(claim.parentless ? 1 : 3);
      expect(setup.authRequests).toEqual(
        claim.refresh ? ["POST /login", "POST /login"] : ["POST /login"],
      );
    } finally {
      await runtime?.close();
      await setup.close();
    }
  });

  it("attaches newly known parents through actual login at the same source revision", async () => {
    const setup = await fixture();
    setup.setLogin({ ...SOURCE_ORGANIZATION, team: null, group: null });
    let runtime: PlatformClawWebIngressRuntime | undefined;
    try {
      runtime = setup.createRuntime();
      const baseUrl = await listen(runtime);
      const login = async (cookie?: string) =>
        fetch(`${baseUrl}/platformclaw/api/auth/login`, {
          method: "POST",
          headers: {
            Origin: ORIGIN,
            "Content-Type": "application/json",
            ...(cookie ? { Cookie: cookie } : {}),
          },
          body: JSON.stringify({ identifier: "person.one", password: "test-password" }),
        });
      const first = await login();
      expect(first.status).toBe(200);
      const cookie = first.headers.get("set-cookie")!.split(";", 1)[0]!;
      expect(await runtime.auth.store.listManagedScopes()).toMatchObject([
        { kind: "part", name: "Agents" },
      ]);
      setup.setLogin(SOURCE_ORGANIZATION);
      expect((await login(cookie)).status).toBe(200);
      await assertExistingCookie(baseUrl, cookie);
      await assertExistingCookie(baseUrl, cookie);
      expect(await runtime.auth.store.listManagedScopes()).toHaveLength(3);
      expect(setup.authRequests).toEqual(["POST /login", "POST /login"]);
    } finally {
      await runtime?.close();
      await setup.close();
    }
  });

  it("replays a complementary parent claim without retaining the old ancestor or inventing a new edge", async () => {
    const setup = await fixture();
    let runtime: PlatformClawWebIngressRuntime | undefined;
    try {
      runtime = setup.createRuntime();
      const baseUrl = await listen(runtime);
      const login = (cookie?: string) =>
        fetch(`${baseUrl}/platformclaw/api/auth/login`, {
          method: "POST",
          headers: {
            Origin: ORIGIN,
            "Content-Type": "application/json",
            ...(cookie ? { Cookie: cookie } : {}),
          },
          body: JSON.stringify({ identifier: "person.one", password: "test-password" }),
        });
      const first = await login();
      expect(first.status).toBe(200);
      const cookie = first.headers.get("set-cookie")!.split(";", 1)[0]!;
      const store = runtime.auth.store;
      const user = (await store.getUserByAccountId("person.one"))!;
      const scopes = await store.listManagedScopes();
      const oldGroup = scopes.find((scope) => scope.externalKey === "group:platform")!;
      const part = scopes.find((scope) => scope.externalKey === "aicm-part:agents")!;
      const { user: admin } = await store.upsertPrincipal(
        {
          provider: "ldap",
          subject: "admin.user",
          accountId: "admin.user",
          employeeId: "admin.user",
        },
        NOW,
      );
      const manualTeam = await store.createManagedScope({
        actorUserId: admin.id,
        kind: "team",
        name: "Manual responsibility",
        createdAt: NOW,
      });
      await store.setManagedScopeMembership({
        actorUserId: admin.id,
        userId: user.id,
        scopeId: manualTeam.id,
        role: "leader",
        reason: "Explicit responsibility independent of directory ancestry",
        changedAt: NOW,
      });
      const updatedAt = "2026-10-30T00:00:01Z";
      setup.setLogin({ ...SOURCE_ORGANIZATION, group: null, updatedAt });
      const unknownGroupLogin = await login(cookie);
      expect(unknownGroupLogin.status).toBe(200);
      expect(unknownGroupLogin.headers.get("set-cookie")!.split(";", 1)[0]).toBe(cookie);
      expect((await store.getManagedScope(part.id))?.parentScopeId).toBe(oldGroup.id);

      const pendingOrganization = {
        ...SOURCE_ORGANIZATION,
        team: null,
        group: { id: "security", name: "Security" },
        updatedAt,
      };
      setup.setLogin(pendingOrganization);
      const failedSync = vi
        .spyOn(store, "syncDirectoryOrganization")
        .mockRejectedValueOnce(new Error("injected complementary-claim write failure"));
      const complementaryLogin = await login(cookie);
      expect(complementaryLogin.status).toBe(200);
      expect(complementaryLogin.headers.get("set-cookie")!.split(";", 1)[0]).toBe(cookie);
      expect(await store.getEmployeeDirectorySnapshot(user.id)).toEqual({
        org: { ...pendingOrganization, updatedAt: "2026-10-30T00:00:01.000Z" },
        isTestAccount: false,
      });
      expect(failedSync).toHaveBeenCalledOnce();
      failedSync.mockRestore();
      await runtime.close();
      runtime = setup.createRuntime();
      const restarted = await listen(runtime);
      const context = await fetch(`${restarted}/platformclaw/api/organization/context`, {
        headers: { Cookie: cookie },
      });
      expect(context.status).toBe(200);
      expect(await context.json()).toMatchObject({ directorySync: { status: "synced" } });
      const recoveredStore = runtime.auth.store;
      expect((await recoveredStore.getManagedScope(part.id))?.parentScopeId).toBeUndefined();
      expect(
        (await recoveredStore.listEffectiveManagedScopeAccess(user.id)).map(
          (entry) => entry.scope.id,
        ),
      ).not.toContain(oldGroup.id);
      expect(await recoveredStore.listUserManagedScopeMemberships(user.id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ scopeId: part.id, role: "member", managedBy: "ldap-login" }),
          expect.objectContaining({ scopeId: manualTeam.id, role: "leader" }),
        ]),
      );
      const database = new DatabaseSync(setup.databasePath);
      try {
        expect(
          database
            .prepare("SELECT parent_scope_id,directory_parent_key FROM managed_scopes WHERE id=?")
            .get(part.id),
        ).toMatchObject({ parent_scope_id: null, directory_parent_key: "group:security" });
      } finally {
        database.close();
      }
      expect(
        (await recoveredStore.listManagedScopes()).some(
          (scope) => scope.externalKey === "group:security",
        ),
      ).toBe(false);
      expect(setup.authRequests).toEqual(["POST /login", "POST /login", "POST /login"]);
      setup.setLogin({
        ...pendingOrganization,
        group: { id: "conflicting", name: "Conflicting group" },
      });
      const conflictingLogin = await fetch(`${restarted}/platformclaw/api/auth/login`, {
        method: "POST",
        headers: { Origin: ORIGIN, "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ identifier: "person.one", password: "test-password" }),
      });
      expect(conflictingLogin.status).toBe(200);
      expect(await recoveredStore.getEmployeeDirectorySnapshot(user.id)).toEqual({
        org: { ...pendingOrganization, updatedAt: "2026-10-30T00:00:01.000Z" },
        isTestAccount: false,
      });
      expect((await recoveredStore.getManagedScope(part.id))?.parentScopeId).toBeUndefined();
      const rejectedContext = await fetch(`${restarted}/platformclaw/api/organization/context`, {
        headers: { Cookie: cookie },
      });
      expect(await rejectedContext.json()).toMatchObject({
        directorySync: { status: "skipped", reason: "conflicting-organization" },
      });
      const session = await fetch(`${restarted}/platformclaw/api/auth/session`, {
        headers: { Cookie: cookie },
      });
      expect(await session.json()).toMatchObject({
        authenticated: true,
        user: { accountId: "person.one" },
      });
    } finally {
      await runtime?.close();
      await setup.close();
    }
  });

  it.each([
    { org: SOURCE_ORGANIZATION, isTestAccount: true, reason: "test-account" },
    { org: null, isTestAccount: false, reason: "no-organization" },
    {
      org: { ...SOURCE_ORGANIZATION, source: "mapping" },
      isTestAccount: false,
      reason: "untrusted-source",
    },
    {
      org: { ...SOURCE_ORGANIZATION, version: 2 },
      isTestAccount: false,
      reason: "unsupported-version",
    },
  ])(
    "preserves the completed authentication exclusion across context reads and restart: $reason",
    async (claim) => {
      const setup = await fixture();
      setup.setLogin(claim.org, claim.isTestAccount);
      let runtime: PlatformClawWebIngressRuntime | undefined;
      try {
        runtime = setup.createRuntime();
        const baseUrl = await listen(runtime);
        const login = await fetch(`${baseUrl}/platformclaw/api/auth/login`, {
          method: "POST",
          headers: { Origin: ORIGIN, "Content-Type": "application/json" },
          body: JSON.stringify({ identifier: "person.one", password: "test-password" }),
        });
        expect(login.status).toBe(200);
        const cookie = login.headers.get("set-cookie")!.split(";", 1)[0]!;
        for (const restart of [false, true]) {
          if (restart) {
            await runtime.close();
            runtime = setup.createRuntime();
          }
          const currentUrl = restart ? await listen(runtime) : baseUrl;
          const response = await fetch(`${currentUrl}/platformclaw/api/organization/context`, {
            headers: { Cookie: cookie },
          });
          const context = await response.json();
          expect(context).toMatchObject({
            directorySync: { status: "skipped", reason: claim.reason },
            directMemberships: [],
          });
          expect(context.directorySync).not.toHaveProperty("refreshUrl");
          expect(await runtime.auth.store.listManagedScopes()).toEqual([]);
        }
        expect(setup.authRequests).toEqual(["POST /login"]);
      } finally {
        await runtime?.close();
        await setup.close();
      }
    },
  );

  it.each([
    { name: "test-account", org: SOURCE_ORGANIZATION, testAccount: true, reason: "test-account" },
    {
      name: "stale-source",
      org: { ...SOURCE_ORGANIZATION, updatedAt: "2026-10-29T23:59:59Z" },
      testAccount: false,
      reason: "stale-organization",
    },
    {
      name: "conflicting-source",
      org: { ...SOURCE_ORGANIZATION, group: { id: "other", name: "Other group" } },
      testAccount: false,
      reason: "conflicting-organization",
    },
  ])("does not replay a prior accepted fact after a newer $name login", async (claim) => {
    const setup = await fixture();
    let runtime: PlatformClawWebIngressRuntime | undefined;
    try {
      runtime = setup.createRuntime();
      const baseUrl = await listen(runtime);
      const failure = vi
        .spyOn(runtime.auth.store, "syncDirectoryOrganization")
        .mockRejectedValueOnce(new Error("injected sync failure"));
      const login = async (cookie?: string) =>
        fetch(`${baseUrl}/platformclaw/api/auth/login`, {
          method: "POST",
          headers: {
            Origin: ORIGIN,
            "Content-Type": "application/json",
            ...(cookie ? { Cookie: cookie } : {}),
          },
          body: JSON.stringify({ identifier: "person.one", password: "test-password" }),
        });
      const first = await login();
      expect(first.status).toBe(200);
      const cookie = first.headers.get("set-cookie")!.split(";", 1)[0]!;
      failure.mockRestore();
      setup.setLogin(claim.org, claim.testAccount);
      expect((await login(cookie)).status).toBe(200);
      for (const restart of [false, true]) {
        if (restart) {
          await runtime.close();
          runtime = setup.createRuntime();
        }
        const currentUrl = restart ? await listen(runtime) : baseUrl;
        const response = await fetch(`${currentUrl}/platformclaw/api/organization/context`, {
          headers: { Cookie: cookie },
        });
        expect(await response.json()).toMatchObject({
          directorySync: { status: "skipped", reason: claim.reason },
          directMemberships: [],
        });
        expect(await runtime.auth.store.listManagedScopes()).toEqual([]);
      }
    } finally {
      await runtime?.close();
      await setup.close();
    }
  });

  it.each([
    { org: SOURCE_ORGANIZATION, isTestAccount: true, name: "test account", clockDelta: 1 },
    { org: null, isTestAccount: false, name: "missing organization", clockDelta: 1 },
    {
      org: SOURCE_ORGANIZATION,
      isTestAccount: true,
      name: "equal-clock test account",
      clockDelta: 0,
    },
    { org: null, isTestAccount: false, name: "equal-clock missing organization", clockDelta: 0 },
    {
      org: { ...SOURCE_ORGANIZATION, updatedAt: "2026-10-30T00:00:01Z" },
      isTestAccount: false,
      name: "eligible organization",
      clockDelta: 0,
    },
  ])(
    "does not replay an older fact when the newer $name decision cannot be recorded",
    async (claim) => {
      const setup = await fixture();
      let runtime: PlatformClawWebIngressRuntime | undefined;
      try {
        runtime = setup.createRuntime();
        const baseUrl = await listen(runtime);
        const syncFailure = vi
          .spyOn(runtime.auth.store, "syncDirectoryOrganization")
          .mockRejectedValueOnce(new Error("injected organization write failure"));
        const login = async (cookie?: string) =>
          fetch(`${baseUrl}/platformclaw/api/auth/login`, {
            method: "POST",
            headers: {
              Origin: ORIGIN,
              "Content-Type": "application/json",
              ...(cookie ? { Cookie: cookie } : {}),
            },
            body: JSON.stringify({ identifier: "person.one", password: "test-password" }),
          });
        const first = await login();
        expect(first.status).toBe(200);
        const cookie = first.headers.get("set-cookie")!.split(";", 1)[0]!;
        const user = await runtime.auth.store.getUserByAccountId("person.one");
        expect(await runtime.auth.store.getEmployeeDirectorySnapshot(user!.id)).not.toBeNull();
        expect(await runtime.auth.store.listManagedScopes()).toEqual([]);
        syncFailure.mockRestore();

        setup.setNow(NOW + claim.clockDelta);
        setup.setLogin(claim.org, claim.isTestAccount);
        const database = new DatabaseSync(setup.databasePath);
        try {
          database.exec(`CREATE TRIGGER fail_directory_auth_decision
            BEFORE UPDATE ON employee_directory_auth_decisions
            BEGIN SELECT RAISE(ABORT, 'injected authentication decision write failure'); END`);
          expect((await login(cookie)).status).toBe(200);
          expect(await runtime.auth.store.getEmployeeDirectorySnapshot(user!.id)).toEqual({
            org: { ...SOURCE_ORGANIZATION, updatedAt: "2026-10-30T00:00:00.000Z" },
            isTestAccount: false,
          });
          const current = (await runtime.auth.store.getUserById(user!.id))!;
          expect(current.lastLoginAt).toBeGreaterThan(user!.lastLoginAt!);
          expect(
            await runtime.auth.store.getEmployeeDirectoryAuthDecision(
              user!.id,
              current.lastLoginAt!,
            ),
          ).toBeNull();
          expect(
            await runtime.auth.store.getEmployeeDirectoryAuthDecision(user!.id, user!.lastLoginAt!),
          ).toBe("eligible");
        } finally {
          database.exec("DROP TRIGGER IF EXISTS fail_directory_auth_decision");
          database.close();
        }

        for (const restart of [false, true]) {
          if (restart) {
            await runtime.close();
            runtime = setup.createRuntime();
          }
          const currentUrl = restart ? await listen(runtime) : baseUrl;
          const response = await fetch(`${currentUrl}/platformclaw/api/organization/context`, {
            headers: { Cookie: cookie },
          });
          expect(await response.json()).toMatchObject({
            directorySync: { status: "skipped", reason: "requires-authenticated-org" },
            directMemberships: [],
          });
          expect(await runtime.auth.store.listManagedScopes()).toEqual([]);
        }
        expect(setup.authRequests).toEqual(["POST /login", "POST /login"]);
      } finally {
        await runtime?.close();
        await setup.close();
      }
    },
  );

  it("does not replay an older fact while an equal-clock test-account login is provisioning", async () => {
    const setup = await fixture();
    let runtime: PlatformClawWebIngressRuntime | undefined;
    try {
      runtime = setup.createRuntime();
      const baseUrl = await listen(runtime);
      const syncFailure = vi
        .spyOn(runtime.auth.store, "syncDirectoryOrganization")
        .mockRejectedValueOnce(new Error("injected organization write failure"));
      const login = async (cookie?: string) =>
        fetch(`${baseUrl}/platformclaw/api/auth/login`, {
          method: "POST",
          headers: {
            Origin: ORIGIN,
            "Content-Type": "application/json",
            ...(cookie ? { Cookie: cookie } : {}),
          },
          body: JSON.stringify({ identifier: "person.one", password: "test-password" }),
        });
      const first = await login();
      expect(first.status).toBe(200);
      const cookie = first.headers.get("set-cookie")!.split(";", 1)[0]!;
      syncFailure.mockRestore();
      setup.setLogin(SOURCE_ORGANIZATION, true);
      const gate = setup.deferNextProfileSeed();
      const pendingLogin = login(cookie);
      let context: unknown;
      try {
        await gate.started;
        const response = await fetch(`${baseUrl}/platformclaw/api/organization/context`, {
          headers: { Cookie: cookie },
        });
        context = await response.json();
      } finally {
        gate.release();
        expect((await pendingLogin).status).toBe(200);
      }
      expect(context).toMatchObject({
        directorySync: { status: "skipped", reason: "requires-authenticated-org" },
        directMemberships: [],
      });
      const completed = await fetch(`${baseUrl}/platformclaw/api/organization/context`, {
        headers: { Cookie: cookie },
      });
      expect(await completed.json()).toMatchObject({
        directorySync: { status: "skipped", reason: "test-account" },
        directMemberships: [],
      });
      expect(await runtime.auth.store.listManagedScopes()).toEqual([]);
    } finally {
      await runtime?.close();
      await setup.close();
    }
  });

  it("records verified signed-SSO facts and retains the same cookie through restart", async () => {
    const setup = await fixture();
    let runtime: PlatformClawWebIngressRuntime | undefined;
    try {
      runtime = setup.createRuntime();
      const baseUrl = await listen(runtime);
      const signed = (secret = SSO_SECRET, expired = false) => {
        const issuedAt = NOW / 1_000 - (expired ? 61 : 0);
        const payload = Buffer.from(
          JSON.stringify({
            contractVersion: 1,
            kind: "sso",
            issuer: "platformclaw-auth",
            audience: "platformclaw",
            authMethod: "saml",
            employeeId: "person.sso",
            agentId: "legacy-agent",
            sessionKey: "agent:legacy-agent:main",
            iat: issuedAt,
            exp: issuedAt + 60,
            org: SOURCE_ORGANIZATION,
          }),
        );
        return `${payload.toString("base64url")}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
      };
      for (const rejected of [signed("incorrect-signing-secret"), signed(SSO_SECRET, true)]) {
        const response = await fetch(
          `${baseUrl}/employee/auth/sso-callback?token=${encodeURIComponent(rejected)}`,
          { redirect: "manual" },
        );
        expect(response.status).toBe(401);
        expect(await runtime.auth.store.getUserByAccountId("person.sso")).toBeNull();
        expect(await runtime.auth.store.listManagedScopes()).toEqual([]);
      }
      const response = await fetch(
        `${baseUrl}/employee/auth/sso-callback?token=${encodeURIComponent(signed())}`,
        { redirect: "manual" },
      );
      expect(response.status).toBe(302);
      const cookie = response.headers
        .getSetCookie()
        .find((value) => value.startsWith("platformclaw_session="))!
        .split(";", 1)[0]!;
      await assertExistingCookie(baseUrl, cookie, "person.sso");
      await runtime.close();
      runtime = setup.createRuntime();
      await assertExistingCookie(await listen(runtime), cookie, "person.sso");
      expect(setup.authRequests).toEqual([]);
    } finally {
      await runtime?.close();
      await setup.close();
    }
  });
});
