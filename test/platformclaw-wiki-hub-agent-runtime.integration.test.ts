import { randomUUID } from "node:crypto";
import { realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AnyAgentTool, OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import wikiPlugin from "../extensions/memory-wiki/index.js";
import hubPlugin from "../extensions/platformclaw-org-memory/index.js";
import {
  PlatformClawExecutionHandoffServer,
  deriveExecutionHandoffAddress,
} from "../packages/platformclaw-control-plane/src/execution-handoff-http.js";
import { createWikiHubTestFixture } from "../packages/platformclaw-control-plane/src/wiki-hub.test-fixtures.js";
import { resetPluginBlobStoreForTests } from "../src/plugin-state/plugin-blob-store.js";
import { resetPluginStateStoreForTests } from "../src/plugin-state/plugin-state-store.js";
import { clearPluginHostRuntimeState } from "../src/plugins/host-hook-runtime.js";
import { createPluginRecord } from "../src/plugins/loader-records.js";
import { loadManifestContractSnapshot } from "../src/plugins/manifest-contract-eligibility.js";
import { createPluginRegistry } from "../src/plugins/registry.js";
import { resetPluginRuntimeStateForTest } from "../src/plugins/runtime.js";
import { resolvePluginRuntimeLoadContext } from "../src/plugins/runtime/load-context.js";
import type { PluginRuntime } from "../src/plugins/runtime/types.js";
import { pluginToolDescriptorCacheState } from "../src/plugins/tool-descriptor-cache.js";
import { resolvePluginTools } from "../src/plugins/tools.js";
import { resetPluginToolDescriptorCacheForTest } from "../src/plugins/tools.test-fixtures.js";

// This boundary supplies the already-prepared registry, just like the agent runner.
// Re-entering the module loader would discard that registry's Shared providers.
const loader = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("../src/plugins/loader.js", () => ({
  loadPluginRegistryHandle: (options: unknown) => loader.load(options),
  resolveCompatibleRuntimePluginRegistry: () => undefined,
}));

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  clearPluginHostRuntimeState();
  resetPluginRuntimeStateForTest();
  resetPluginToolDescriptorCacheForTest();
  loader.load.mockReset();
  resetPluginBlobStoreForTests();
  resetPluginStateStoreForTests();
  vi.unstubAllEnvs();
  for (const close of cleanup.splice(0).toReversed()) {
    await close();
  }
});

describe("Wiki Hub composed tool contract", () => {
  it.each(["discovery", "tool-discovery"] as const)(
    "preserves Shared search/read/update through cold and cached %s tools",
    async (registrationMode) => {
      const f = await createWikiHubTestFixture();
      cleanup.push(f.close);
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
      vi.stubEnv("OPENCLAW_STATE_DIR", join(f.root, "state"));
      vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", resolve("extensions"));
      const workspaceDir = await realpath(f.root);
      const config: OpenClawConfig = {
        agents: { list: [{ id: f.binding.agentId, default: true, workspace: workspaceDir }] },
        plugins: {
          enabled: true,
          allow: [hubPlugin.id, wikiPlugin.id],
          slots: { memory: "none" },
          entries: {
            [hubPlugin.id]: { enabled: true },
            [wikiPlugin.id]: {
              enabled: true,
              config: { vault: { scope: "agent", path: join(f.root, "personal") } },
            },
          },
        },
      };
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
      const runtime = { config: { current: () => config }, state: {} } as PluginRuntime;
      const builder = createPluginRegistry({ logger, runtime, activateGlobalSideEffects: false });
      const snapshot = loadManifestContractSnapshot({ config, workspaceDir });
      for (const plugin of [hubPlugin, wikiPlugin]) {
        const manifest = snapshot.plugins.find((entry) => entry.id === plugin.id)!;
        const record = createPluginRecord({
          id: plugin.id,
          source: resolve("extensions", plugin.id, "index.ts"),
          rootDir: resolve("extensions", plugin.id),
          origin: "bundled",
          enabled: true,
          configSchema: true,
          contracts: manifest.contracts,
        });
        plugin.register(
          builder.createApi(record, {
            config,
            pluginConfig: config.plugins!.entries![plugin.id]!.config,
            registrationMode,
          }),
        );
        builder.registry.plugins.push(record);
      }
      const loadContext = resolvePluginRuntimeLoadContext({ config, workspaceDir });
      const preparedRuntime = {
        loadContext,
        metadataSnapshot: snapshot,
        registry: builder.registry,
      };
      const search = vi.spyOn(f.service, "search");
      loader.load.mockImplementation(() => {
        throw new Error("Prepared agent tool execution unexpectedly discarded its owning registry");
      });
      const resolveTools = (runId: string) =>
        new Map<string, AnyAgentTool>(
          resolvePluginTools({
            context: {
              config: loadContext.config,
              workspaceDir,
              agentId: f.binding.agentId,
              runId,
            },
            // Shared is a search provider, not an extra user-visible tool grant.
            toolAllowlist: ["wiki_search", "wiki_get", "wiki_apply"],
            preparedRuntime,
          }).map((tool) => [tool.name, tool]),
        );
      let registered = resolveTools("turn-one");
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
      expect(search).toHaveBeenCalledTimes(1);
      expect(pluginToolDescriptorCacheState.descriptors.size).toBeGreaterThan(0);
      // Warm descriptors must still execute against the prepared registry, while
      // instantiating tool factories with this invocation's run context.
      registered = resolveTools("turn-one");
      expect(
        (await call("wiki_search", { query: "Calibration", vaultName: f.vault.name })).details,
      ).toMatchObject({ results: [expect.objectContaining({ vaultId: f.vault.id })] });
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
      f.store.vaults.removeMember({
        userId: other.id,
        vaultId: denied.id,
        memberUserId: f.user.id,
      });
      expect((await call("wiki_get", { lookup: hiddenPath })).details).toMatchObject({
        found: false,
        disabled: true,
      });
      expect(
        (await call("wiki_search", { query: "Reader-only", vaultId: denied.id })).details,
      ).toMatchObject({ results: [] });
      expect(
        JSON.stringify(await call("wiki_search", { query: "Reader-only", vaultId: denied.id })),
      ).not.toContain("Reader-only fact");
      f.store.vaults.setConnection({ userId: f.user.id, vaultId: f.vault.id, connected: false });
      expect((await call("wiki_search", { query: "Calibration" })).details).toMatchObject({
        results: [expect.objectContaining({ vaultId: f.vault.id })],
      });
      registered = resolveTools("turn-two");
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
      expect(loader.load).not.toHaveBeenCalled();
    },
  );
});
