import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, vi } from "vitest";
import { BrowserAuthService, hashBrowserSessionToken } from "./browser-auth-service.js";
import { BrowserGatewayProxy, type BrowserGatewayRpc } from "./browser-gateway-proxy.js";
import { KnowledgeVaultService } from "./knowledge-vault-service.js";
import { SqliteControlPlaneStore } from "./sqlite-store.js";

export async function setupBrowserKnowledgeVault() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vault-browser-")));
  const store = new SqliteControlPlaneStore({
    databasePath: join(root, "control.sqlite"),
    initialAdminAccountIds: ["employee"],
    buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
  });
  onTestFinished(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const { user } = await store.upsertPrincipal(
    { provider: "ldap", subject: "employee", accountId: "employee", employeeId: "employee" },
    Date.now(),
  );
  const reserved = await store.reservePersonalAgent(user.id, Date.now());
  const binding = await store.transitionAgent({
    bindingId: reserved.binding.id,
    state: "active",
    changedAt: Date.now(),
  });
  const token = "vault-test-session";
  await store.createBrowserSession({
    userId: user.id,
    tokenHash: hashBrowserSessionToken(token),
    createdAt: Date.now(),
  });
  const auth = new BrowserAuthService({
    store,
    authenticator: {
      authenticatePassword: async () => ({ status: "rejected", message: "unused" }),
    },
    provisioner: { provisionOrRefresh: async () => {} },
  });
  const request = vi.fn<BrowserGatewayRpc["request"]>(async (method) =>
    method === "wiki.search"
      ? [
          {
            corpus: "wiki",
            path: "concepts/training.md",
            title: "Training",
            kind: "concept",
            snippet: "training wiki",
            score: 0.8,
            revision: "b".repeat(64),
          },
        ]
      : {
          agentId: binding.agentId,
          provider: "local",
          searchMode: "fts-only",
          results: [
            {
              path: "MEMORY.md",
              snippet: "training memory",
              source: "memory",
              score: 0.7,
              startLine: 1,
              endLine: 2,
              sourceVersion: "a".repeat(64),
            },
          ],
        },
  );
  const vaultService = new KnowledgeVaultService(store, { request });
  const proxy = new BrowserGatewayProxy({
    authService: auth,
    store,
    auditWriter: store,
    gateway: { request },
    vaultService,
    buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
    resolveAgentIdFromSessionKey: (key) => key.split(":")[1] ?? null,
  });
  return {
    store,
    user,
    binding,
    token,
    request,
    proxy,
    vaultService,
    auth,
    databasePath: join(root, "control.sqlite"),
  };
}
