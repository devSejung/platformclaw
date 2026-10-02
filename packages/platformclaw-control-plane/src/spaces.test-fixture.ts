import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, vi } from "vitest";
import { BrowserAuthService, hashBrowserSessionToken } from "./browser-auth-service.js";
import { BrowserGatewayProxy } from "./browser-gateway-proxy.js";
import { SpaceService } from "./space-service.js";
import { SqliteControlPlaneStore } from "./sqlite-store.js";
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) {
    fn();
  }
});
export async function createSpaceTestFixture(runtimeReady = true) {
  const root = mkdtempSync(join(tmpdir(), "spaces-"));
  const store = new SqliteControlPlaneStore({
    databasePath: join(root, "control.sqlite"),
    initialAdminAccountIds: ["alice"],
    buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
  });
  cleanup.push(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const users = [];
  for (const account of ["alice", "bob", "carol"]) {
    const { user } = await store.upsertPrincipal(
      { provider: "ldap", subject: account, accountId: account, employeeId: account },
      Date.now(),
    );
    const reserved = await store.reservePersonalAgent(user.id, Date.now());
    const binding = await store.transitionAgent({
      bindingId: reserved.binding.id,
      state: "active",
      changedAt: Date.now(),
    });
    await store.createBrowserSession({
      userId: user.id,
      tokenHash: hashBrowserSessionToken(account),
      createdAt: Date.now(),
    });
    users.push({ user, binding, token: account });
  }
  const [alice, bob, carol] = users as [
    (typeof users)[number],
    (typeof users)[number],
    (typeof users)[number],
  ];
  const sessions = new Set<string>();
  const request = vi.fn(
    async (method: string, params?: unknown): Promise<unknown> =>
      method === "sessions.resolve"
        ? {
            ok: sessions.has((params as { key: string }).key),
            key: (params as { key: string }).key,
          }
        : method === "sessions.create"
          ? (sessions.add((params as { key: string }).key),
            { ok: true, key: (params as { key: string }).key })
          : method === "sessions.abort"
            ? { ok: true, status: "aborted" }
            : method === "chat.history"
              ? { messages: [] }
              : method === "chat.abort"
                ? { ok: true, aborted: true }
                : method === "sessions.search"
                  ? { results: [] }
                  : method === "models.list"
                    ? { models: [] }
                    : { status: "started" },
  );
  const service = new SpaceService(store, { request }, runtimeReady);
  const auth = new BrowserAuthService({
    store,
    authenticator: {
      authenticatePassword: async () => ({ status: "rejected", message: "unused" }),
    },
    provisioner: { provisionOrRefresh: async () => {} },
  });
  const proxy = new BrowserGatewayProxy({
    store,
    authService: auth,
    auditWriter: store,
    gateway: { request },
    spaceService: service,
    buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
    resolveAgentIdFromSessionKey: (key) => key.split(":")[1] ?? null,
  });
  const space = store.spaces.create(alice.user.id, "PMU", "create-pmu");
  const page = store.spaces.createPage(alice.user.id, space.id, {
    title: "SPMI timeout",
    body: "Board revision A",
    requestId: "page-one",
  });
  store.spaces.beginRun(
    alice.user.id,
    space.id,
    page.id,
    "fixture-history",
    "existing shared question",
  );
  return { store, service, proxy, request, alice, bob, carol, space, page, auth };
}
