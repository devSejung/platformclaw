import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { KnowledgeVaultService } from "./knowledge-vault-service.js";
import { SqliteControlPlaneStore } from "./sqlite-store.js";

export async function createWikiHubTestFixture() {
  const root = await mkdtemp(join(tmpdir(), "wiki-hub-agent-"));
  const store = new SqliteControlPlaneStore({
    databasePath: join(root, "control.sqlite"),
    initialAdminAccountIds: ["bootstrap-admin"],
    buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
  });
  const { user } = await store.upsertPrincipal(
    { provider: "ldap", subject: "owner", accountId: "owner", employeeId: "owner" },
    Date.now(),
  );
  const reserved = await store.reservePersonalAgent(user.id, Date.now());
  const binding = await store.transitionAgent({
    bindingId: reserved.binding.id,
    state: "active",
    changedAt: Date.now(),
  });
  if (binding.kind !== "personal") {
    throw new Error("Expected Personal agent binding");
  }
  store.vaults.setPersonalEnabled(user.id, false);
  const vault = store.vaults.createVault({ userId: user.id, name: "Training Wiki" });
  const prefix = "---\ntitle: Training\ncustom: preserved\n---\n";
  const document = store.vaults.saveDocument({
    userId: user.id,
    vaultId: vault.id,
    content: prefix + "Calibration original",
  });
  const request = vi.fn(async (method: string) =>
    method === "wiki.search"
      ? [
          {
            corpus: "wiki",
            path: "concepts/training.md",
            title: "Training",
            kind: "concept",
            snippet: "Calibration personal Wiki",
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
              snippet: "Calibration automatic Memory",
              source: "memory",
              score: 0.7,
              startLine: 1,
              endLine: 1,
              sourceVersion: "a".repeat(64),
            },
          ],
        },
  );
  const service = new KnowledgeVaultService(store, { request });
  return {
    root,
    store,
    user,
    binding,
    vault,
    document,
    prefix,
    request,
    service,
    close: async () => {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
