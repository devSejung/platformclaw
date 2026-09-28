import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import wikiPlugin from "../../../extensions/memory-wiki/index.js";
import hubPlugin from "../../../extensions/platformclaw-org-memory/index.js";
import {
  clearMemoryPluginState,
  registerMemoryCorpusSupplement,
} from "../../../src/plugin-sdk/memory-host-core.js";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolFactory,
  PluginJsonValue,
} from "../../../src/plugin-sdk/plugin-entry.js";
import { createTestPluginApi } from "../../../src/plugin-sdk/plugin-test-api.js";
import { BrowserAuthService } from "./browser-auth-service.js";
import type { BrowserGatewayProxyOptions } from "./browser-gateway-contracts.js";
import { requestBrowserKnowledgeSearch } from "./browser-knowledge-search.js";
import {
  PlatformClawExecutionHandoffServer,
  deriveExecutionHandoffAddress,
} from "./execution-handoff-http.js";
import { KnowledgeVaultService } from "./knowledge-vault-service.js";
import { SqliteControlPlaneStore } from "./sqlite-store.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  clearMemoryPluginState();
  vi.unstubAllEnvs();
  for (const close of cleanup.splice(0).toReversed()) {
    await close();
  }
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "wiki-hub-agent-"));
  const store = new SqliteControlPlaneStore({
    databasePath: join(root, "control.sqlite"),
    initialAdminAccountIds: ["bootstrap-admin"],
    buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
  });
  cleanup.push(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
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
  return { root, store, user, binding, vault, document, prefix, request, service };
}

describe("Wiki Hub composed tool contract", () => {
  it("runs registered search → read → revision update over the real socket and SQLite ACL owner", async () => {
    const f = await fixture();
    const broker =
      process.platform === "win32"
        ? String.raw`\\.\pipe\wiki-hub-${randomUUID()}`
        : join(f.root, "broker.sock");
    const token = "wiki-hub-test-service-token-at-least-32-bytes";
    const tokenFile = join(f.root, "service-token");
    await writeFile(tokenFile, token);
    const server = new PlatformClawExecutionHandoffServer(
      token,
      {
        vaultService: f.service,
        resolveTarget: vi.fn(),
        resolveConnectionTarget: vi.fn(),
        changeTarget: vi.fn(),
        issueCredentialGrant: vi.fn(),
      },
      deriveExecutionHandoffAddress(broker),
    );
    await server.listen();
    cleanup.push(async () => await server.close());
    vi.stubEnv("PLATFORMCLAW_CREDENTIAL_BROKER_ADDRESS", broker);
    vi.stubEnv("PLATFORMCLAW_EXECUTION_SERVICE_TOKEN_FILE", tokenFile);
    const runState = new Map<string, PluginJsonValue | undefined>();
    hubPlugin.register(
      createTestPluginApi({
        id: hubPlugin.id,
        getRunContext: ({ runId, namespace }) => runState.get(`${runId}:${namespace}`),
        setRunContext: ({ runId, namespace, value }) => {
          runState.set(`${runId}:${namespace}`, value);
          return true;
        },
        registerMemoryCorpusSupplement: (supplement) =>
          registerMemoryCorpusSupplement(hubPlugin.id, supplement),
      }),
    );
    // This trace disables Personal Wiki. Any accidental local state read is a failure,
    // rather than a mocked Personal result concealing incorrect default dispatch.
    const unexpectedPersonalState = () => {
      throw new Error("Disabled Personal Wiki state was accessed");
    };
    const registerTool = vi.fn();
    wikiPlugin.register(
      createTestPluginApi({
        id: wikiPlugin.id,
        config: { agents: { list: [{ id: f.binding.agentId, default: true }] } },
        pluginConfig: { vault: { scope: "agent", path: join(f.root, "personal") } },
        runtime: {
          state: {
            openKeyedStore: unexpectedPersonalState,
            openBlobStore: () => ({ lookup: unexpectedPersonalState }),
          },
        } as unknown as OpenClawPluginApi["runtime"],
        registerTool,
      }),
    );
    const registered = new Map<string, AnyAgentTool>();
    for (const [factory, options] of registerTool.mock.calls) {
      const tool = (factory as OpenClawPluginToolFactory)({
        agentId: f.binding.agentId,
        runId: "turn-one",
      });
      if (tool && !Array.isArray(tool)) {
        registered.set(options.name, tool);
      }
    }
    async function call(name: string, input: Record<string, unknown>) {
      const tool = registered.get(name)!;
      expect(Value.Check(tool.parameters, input)).toBe(true);
      return await tool.execute(`trace-${name}`, input);
    }
    const found = await call("wiki_search", { query: "Calibration" });
    const hits = (
      found.details as { results: Array<{ path: string; vaultId: string; revision: number }> }
    ).results;
    expect(hits).toEqual([
      expect.objectContaining({
        vaultId: f.vault.id,
        vaultName: "Training Wiki",
        vaultType: "shared",
        documentId: f.document.id,
        revision: f.document.revision,
        link: f.document.link,
        title: "Training",
        path: `shared/${f.vault.id}/${f.document.id}`,
        snippet: expect.stringContaining("Calibration original"),
      }),
    ]);
    const read = await call("wiki_get", { lookup: hits[0]!.path });
    expect(read.details).toMatchObject({
      content: "Calibration original",
      revision: String(f.document.revision),
      editMode: "body",
      truncated: false,
      link: f.document.link,
    });
    const saved = await call("wiki_apply", {
      op: "update",
      vaultName: "Training Wiki",
      lookup: hits[0]!.path,
      expectedRevision: String(f.document.revision),
      body: "Calibration revised",
    });
    expect(saved.details).toMatchObject({
      vaultId: f.vault.id,
      revision: String(Number(f.document.revision) + 1),
    });
    expect((await call("wiki_get", { lookup: hits[0]!.path })).details).toMatchObject({
      content: "Calibration revised",
    });
    expect(
      f.store.vaults.readDocument({
        userId: f.user.id,
        vaultId: f.vault.id,
        documentId: f.document.id,
      }).sourceContent,
    ).toBe(f.prefix + "Calibration revised");
    const { user: other } = await f.store.upsertPrincipal(
      { provider: "ldap", subject: "other", accountId: "other", employeeId: "other" },
      Date.now(),
    );
    const denied = f.store.vaults.createVault({ userId: other.id, name: "Hidden Wiki" });
    const response = await call("wiki_apply", {
      op: "create",
      vaultId: denied.id,
      title: "Denied",
      body: "must not persist",
    });
    expect(JSON.stringify(response)).toContain("wiki-forbidden");
    expect(JSON.stringify(response)).toContain("access");
    expect(
      f.store.vaults.snapshot({ userId: other.id, vaultId: denied.id }).selected?.documents,
    ).toHaveLength(0);
    const hiddenDocument = f.store.vaults.saveDocument({
      userId: other.id,
      vaultId: denied.id,
      title: "Hidden",
      content: "Reader-only fact",
    });
    f.store.vaults.setMember({
      userId: other.id,
      vaultId: denied.id,
      memberUserId: f.user.id,
      role: "reader",
    });
    const hiddenPath = `shared/${denied.id}/${hiddenDocument.id}`;
    expect((await call("wiki_get", { lookup: hiddenPath })).details).toMatchObject({
      content: "Reader-only fact",
    });
    f.store.vaults.removeMember({ userId: other.id, vaultId: denied.id, memberUserId: f.user.id });
    expect((await call("wiki_get", { lookup: hiddenPath })).details).toMatchObject({
      found: false,
      disabled: true,
    });
    f.store.vaults.setConnection({ userId: f.user.id, vaultId: f.vault.id, connected: false });
    expect((await call("wiki_search", { query: "Calibration" })).details).toMatchObject({
      results: [expect.objectContaining({ vaultId: f.vault.id })],
    });
    const [factory] = registerTool.mock.calls.find(
      ([, options]) => options.name === "wiki_search",
    )!;
    const nextSearch = (factory as OpenClawPluginToolFactory)({
      agentId: f.binding.agentId,
      runId: "turn-two",
    }) as AnyAgentTool;
    registered.set("wiki_search", nextSearch);
    expect((await call("wiki_search", { query: "Calibration" })).details).toMatchObject({
      results: [],
    });
    expect(
      (await call("wiki_search", { query: "Calibration", vaultId: f.vault.id })).details,
    ).toMatchObject({ results: [expect.objectContaining({ vaultId: f.vault.id })] });
    const missingTarget = { op: "create", title: "No target", body: "Do not guess" };
    expect(Value.Check(registered.get("wiki_apply")!.parameters, missingTarget)).toBe(false);
    expect(
      JSON.stringify(await registered.get("wiki_apply")!.execute("invalid", missingTarget)),
    ).toContain("Select exactly one Wiki");
    expect(f.request).not.toHaveBeenCalled();
  });

  it("excludes disabled Personal Wiki from connected browser search while retaining raw Memory and explicit browse", async () => {
    const f = await fixture();
    const options: BrowserGatewayProxyOptions = {
      authService: new BrowserAuthService({
        store: f.store,
        authenticator: {
          authenticatePassword: async () => ({ status: "rejected", message: "unused" }),
        },
        provisioner: { provisionOrRefresh: async () => {} },
      }),
      store: f.store,
      auditWriter: f.store,
      gateway: { request: f.request },
      vaultService: f.service,
      buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
      resolveAgentIdFromSessionKey: () => null,
    };
    const access = {
      user: f.user,
      binding: f.binding,
      mainSessionKey: `agent:${f.binding.agentId}:main`,
    };
    const connected = await requestBrowserKnowledgeSearch(options, access, "memory.search", {
      query: "Calibration",
    });
    expect(connected).toMatchObject({
      handled: true,
      result: {
        results: expect.arrayContaining([
          expect.objectContaining({ source: "memory" }),
          expect.objectContaining({ source: "shared" }),
        ]),
      },
    });
    expect(f.request.mock.calls.map(([method]) => method)).toEqual(["memory.search"]);
    for (const selection of [{ scope: "all" }, { vaultId: `personal:${f.binding.agentId}` }]) {
      f.request.mockClear();
      const result = await requestBrowserKnowledgeSearch(options, access, "wiki.search", {
        query: "Calibration",
        ...selection,
      });
      expect(result).toMatchObject({
        handled: true,
        result: expect.arrayContaining([expect.objectContaining({ source: "wiki" })]),
      });
      expect(f.request).toHaveBeenCalledWith(
        "wiki.search",
        expect.objectContaining({ vaultId: `personal:${f.binding.agentId}` }),
      );
    }
  });
});
