import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EmployeeOrganizationBackfill } from "./employee-organization-backfill.js";
import { InMemoryControlPlaneStore } from "./memory-store.js";
import { SqliteControlPlaneStore } from "./sqlite-store.js";

const directories: string[] = [];
const stores: SqliteControlPlaneStore[] = [];
const SOURCE_TIME = Date.parse("2026-10-30T00:00:00Z");
const organization = (offset = 0, name = "Agents") => ({
  version: 1,
  source: "aicm",
  team: "Engineering",
  group: { id: "platform", name: "Platform" },
  part: { id: "agents", name },
  updatedAt: new Date(SOURCE_TIME + offset).toISOString(),
});

function createStore() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "platformclaw-directory-snapshot-")));
  directories.push(directory);
  const store = new SqliteControlPlaneStore({
    databasePath: join(directory, "control.sqlite"),
    initialAdminAccountIds: ["admin"],
    buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
  });
  stores.push(store);
  return store;
}

async function createUser(store: SqliteControlPlaneStore, name = "one", time = 1_000) {
  const principal = { provider: "ldap" as const, subject: name, accountId: name, employeeId: name };
  return { principal, user: (await store.upsertPrincipal(principal, time)).user };
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("authenticated employee directory snapshots", () => {
  it.each(["sqlite", "memory"] as const)(
    "gives equal-clock authentications distinct stamps while preserving provider stale checks: %s",
    async (kind) => {
      const store =
        kind === "sqlite"
          ? createStore()
          : new InMemoryControlPlaneStore({
              initialAdminAccountIds: ["admin"],
              buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
            });
      const principal = {
        provider: "ldap" as const,
        subject: "one",
        accountId: "one",
        employeeId: "one",
      };
      const first = await store.upsertPrincipal(principal, 1_000);
      const repeated = await store.upsertPrincipal(principal, 1_000);
      const linked = await store.upsertPrincipal(
        { ...principal, provider: "saml", subject: "saml:one" },
        1_000,
      );
      expect([first.user.lastLoginAt, repeated.user.lastLoginAt, linked.user.lastLoginAt]).toEqual([
        1_000, 1_001, 1_002,
      ]);
      expect(linked.identity.lastAuthenticatedAt).toBe(1_000);
      await expect(store.upsertPrincipal(principal, 999)).rejects.toMatchObject({
        code: "stale_authentication",
      });
      await expect(
        store.upsertPrincipal({ ...principal, employeeId: "changed" }, 1_000),
      ).rejects.toMatchObject({ code: "stale_authentication" });
      expect((await store.getUserById(first.user.id))?.lastLoginAt).toBe(1_002);
      const created = await store.createBrowserSession({
        userId: first.user.id,
        tokenHash: "monotonic-authentication-session",
        createdAt: 1_000,
      });
      expect(created).toMatchObject({ status: "created", session: { createdAt: 1_000 } });
    },
  );

  it("lets a health listener respond before reading the next recovery page", async () => {
    const users = Array.from({ length: 200 }, (_, index) => ({
      id: String(index),
      lastLoginAt: 1_000,
    }));
    let pagesRead = 0;
    const store = {
      async listDirectoryOrganizationBackfillUsers(params: {
        afterUserId?: string;
        limit: number;
      }) {
        pagesRead += 1;
        const offset = params.afterUserId === undefined ? 0 : Number(params.afterUserId) + 1;
        return users.slice(offset, offset + params.limit);
      },
      async getEmployeeDirectorySnapshot() {
        return null;
      },
      async getEmployeeDirectoryAuthDecision() {
        return null;
      },
      async getEmployeeDirectoryBackfillAttempt() {
        return null;
      },
      async recordEmployeeDirectoryBackfillAttempt() {
        return true;
      },
      async syncDirectoryOrganization() {
        return { status: "synced" as const, scopeId: "unused" };
      },
    };
    const owner = new EmployeeOrganizationBackfill({ store });
    let scan: ReturnType<typeof owner.start> | undefined;
    const server = createServer((_request, response) => {
      scan = owner.start();
      // A check-phase response must not wait for every immediately resolved DB task.
      setImmediate(() => {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ pagesRead }));
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const response = await fetch(
        `http://127.0.0.1:${(server.address() as AddressInfo).port}/health`,
      );
      expect(await response.json()).toEqual({ pagesRead: 1 });
      expect(await scan).toMatchObject({ found: 200, skipped: 200, failed: 0, limited: false });
    } finally {
      await owner.stop();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("stores only canonical eligible fields and rejects older or conflicting source data", async () => {
    const store = createStore();
    const { user } = await createUser(store);
    const save = (org: unknown) =>
      store.recordEmployeeDirectoryAuthentication({
        userId: user.id,
        org,
        isTestAccount: false,
        observedAt: 2_000,
        expectedLastLoginAt: 1_000,
      });
    expect(
      await save({ ...organization(1_000), unrelated: "discarded directory metadata" }),
    ).toEqual({ org: organization(1_000), isTestAccount: false });
    expect(await store.getEmployeeDirectorySnapshot(user.id)).toEqual({
      org: organization(1_000),
      isTestAccount: false,
    });
    expect(await save(organization(0, "Old name"))).toBeNull();
    expect(await store.getEmployeeDirectoryAuthDecision(user.id, 1_000)).toBe("stale-organization");
    expect(await save(organization(1_000, "Conflicting name"))).toBeNull();
    expect(await store.getEmployeeDirectoryAuthDecision(user.id, 1_000)).toBe(
      "conflicting-organization",
    );
    expect(await store.getEmployeeDirectorySnapshot(user.id)).toEqual({
      org: organization(1_000),
      isTestAccount: false,
    });
  });

  it("retains same-revision parent refinements without accepting known-parent moves or renames", async () => {
    const store = createStore();
    const { user } = await createUser(store);
    const save = (org: unknown) =>
      store.recordEmployeeDirectoryAuthentication({
        userId: user.id,
        org,
        isTestAccount: false,
        observedAt: 2_000,
        expectedLastLoginAt: 1_000,
      });
    expect(await save({ ...organization(), team: null, group: null })).toEqual({
      org: { ...organization(), team: null, group: null },
      isTestAccount: false,
    });
    expect(await save({ ...organization(), team: null })).toEqual({
      org: { ...organization(), team: null },
      isTestAccount: false,
    });
    expect(await save(organization())).toEqual({ org: organization(), isTestAccount: false });
    for (const conflict of [
      { ...organization(), part: { id: "other", name: "Agents" } },
      organization(0, "Renamed part"),
      { ...organization(), group: { id: "other", name: "Platform" } },
      { ...organization(), group: { id: "platform", name: "Renamed group" } },
      { ...organization(), team: "Other team" },
    ]) {
      expect(await save(conflict)).toBeNull();
    }
    for (const weaker of [
      { ...organization(), group: null },
      { ...organization(), team: null },
    ]) {
      expect(await save(weaker)).toEqual({ org: organization(), isTestAccount: false });
    }
    expect(await store.getEmployeeDirectorySnapshot(user.id)).toEqual({
      org: organization(),
      isTestAccount: false,
    });
  });

  it.each([false, true])(
    "keeps the closest known parent without inventing a Team edge in either claim order: group first %s",
    async (groupFirst) => {
      const store = createStore();
      const { user, principal } = await createUser(store);
      const knownGroup = { ...organization(), team: null };
      const standaloneTeam = { ...organization(), group: null };
      const claims = groupFirst ? [knownGroup, standaloneTeam] : [standaloneTeam, knownGroup];
      for (const [index, org] of claims.entries()) {
        const authentication = await store.upsertPrincipal(principal, 1_000 + index);
        expect(
          await store.recordEmployeeDirectoryAuthentication({
            userId: user.id,
            org,
            isTestAccount: false,
            expectedLastLoginAt: authentication.user.lastLoginAt!,
            observedAt: 2_000 + index,
          }),
        ).toEqual({ org: index === 0 ? claims[0] : knownGroup, isTestAccount: false });
      }
      expect(await store.getEmployeeDirectorySnapshot(user.id)).toEqual({
        org: knownGroup,
        isTestAccount: false,
      });
      expect(await store.getEmployeeDirectoryAuthDecision(user.id, 1_002)).toBe("eligible");
    },
  );

  it.each([
    undefined,
    null,
    { ...organization(), part: null },
    { ...organization(), source: "mapping" },
    { ...organization(), version: 2 },
  ])("does not replace a known fact with unknown or ineligible data: %j", async (org) => {
    const store = createStore();
    const { user } = await createUser(store);
    await store.recordEmployeeDirectoryAuthentication({
      userId: user.id,
      org: organization(),
      isTestAccount: false,
      observedAt: 2_000,
      expectedLastLoginAt: 1_000,
    });
    expect(
      await store.recordEmployeeDirectoryAuthentication({
        userId: user.id,
        org,
        isTestAccount: false,
        observedAt: 3_000,
        expectedLastLoginAt: 1_000,
      }),
    ).toBeNull();
    expect(
      await store.recordEmployeeDirectoryAuthentication({
        userId: user.id,
        org: organization(1_000),
        isTestAccount: true,
        observedAt: 3_000,
        expectedLastLoginAt: 1_000,
      }),
    ).toBeNull();
    expect(await store.getEmployeeDirectorySnapshot(user.id)).toEqual({
      org: organization(),
      isTestAccount: false,
    });
  });

  it("lists only previously authenticated users without duplicate identities or sessions", async () => {
    const store = createStore();
    const first = await createUser(store, "one");
    const second = await createUser(store, "two");
    await createUser(store, "never-completed-login");
    await store.upsertPrincipal(
      { ...first.principal, provider: "saml", subject: "saml:one" },
      1_001,
    );
    for (const [index, user] of [first.user, first.user, second.user].entries()) {
      await store.createBrowserSession({
        userId: user.id,
        tokenHash: `snapshot-session-${index}`,
        createdAt: 2_000,
      });
    }
    const page = await store.listDirectoryOrganizationBackfillUsers({ limit: 1 });
    const next = await store.listDirectoryOrganizationBackfillUsers({
      limit: 1,
      afterUserId: page[0]!.id,
    });
    expect(new Set([...page, ...next].map((entry) => entry.id))).toEqual(
      new Set([first.user.id, second.user.id]),
    );
    expect(
      await store.listDirectoryOrganizationBackfillUsers({ limit: 1, afterUserId: next[0]!.id }),
    ).toEqual([]);
  });

  it("does not replay a captured user version after a newer login commits", async () => {
    const store = createStore();
    const { user, principal } = await createUser(store);
    await store.createBrowserSession({
      userId: user.id,
      tokenHash: "existing-cookie",
      createdAt: 1_001,
    });
    await store.recordEmployeeDirectoryAuthentication({
      userId: user.id,
      org: organization(),
      isTestAccount: false,
      observedAt: 1_000,
      expectedLastLoginAt: 1_000,
    });
    // The scan captures the old user row synchronously before its first await.
    const owner = new EmployeeOrganizationBackfill({ store, now: () => 3_000 });
    const scan = owner.start();
    try {
      await store.upsertPrincipal(principal, 2_000);
      await store.recordEmployeeDirectoryAuthentication({
        userId: user.id,
        org: organization(1_000, "New source"),
        isTestAccount: false,
        observedAt: 2_000,
        expectedLastLoginAt: 2_000,
      });
      await store.syncDirectoryOrganization({
        userId: user.id,
        org: organization(1_000, "New source"),
        isTestAccount: false,
        syncedAt: 2_000,
        expectedLastLoginAt: 2_000,
      });
      expect(await scan).toMatchObject({ found: 1, skipped: 1, failed: 0 });
      expect(
        (await store.listManagedScopes()).find((scope) => scope.kind === "part"),
      ).toMatchObject({
        name: "New source",
      });
      expect(await store.getEmployeeDirectorySnapshot(user.id)).toEqual({
        org: organization(1_000, "New source"),
        isTestAccount: false,
      });
    } finally {
      await owner.stop();
    }
  });
});
