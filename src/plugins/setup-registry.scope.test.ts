// Verifies setup caches against real manifests and overlapping metadata owners.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferred } from "../test-utils/deferred.js";
import {
  setCurrentPluginMetadataSnapshot,
  withPluginMetadataSnapshotScope,
} from "./current-plugin-metadata-snapshot.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import { resolvePluginSetupProvider, resolvePluginSetupRegistry } from "./setup-registry.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const PLUGIN_ID = "setup-scope-owner";
const PROVIDER_IDS = ["old-provider", "new-provider"] as const;
const tempRoots: string[] = [];

function createFixture() {
  const root = fs.realpathSync(makeTrackedTempDir("setup-registry-scope", tempRoots));
  const directories = {
    HOME: path.join(root, "home"),
    USERPROFILE: path.join(root, "home"),
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(root, "bundled"),
  };
  for (const [key, directory] of Object.entries(directories)) {
    fs.mkdirSync(directory, { recursive: true });
    vi.stubEnv(key, directory);
  }
  vi.stubEnv("OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR", "1");
  const config: OpenClawConfig = { plugins: { allow: [PLUGIN_ID] } };
  return { root, config };
}

function prepareOwner(
  fixture: ReturnType<typeof createFixture>,
  workspaceName: string,
  providerId: (typeof PROVIDER_IDS)[number],
) {
  const workspaceDir = path.join(fixture.root, workspaceName);
  const pluginRoot = path.join(workspaceDir, ".openclaw", "extensions", PLUGIN_ID);
  fs.mkdirSync(pluginRoot, { recursive: true });
  fs.writeFileSync(
    path.join(pluginRoot, "package.json"),
    JSON.stringify({
      name: `@fixture/${PLUGIN_ID}`,
      version: "1.0.0",
      type: "module",
      openclaw: { extensions: ["./index.js"] },
    }),
  );
  fs.writeFileSync(path.join(pluginRoot, "index.js"), "export default {};\n");
  // Keep executable code identical: the owner change is the manifest descriptor.
  fs.writeFileSync(
    path.join(pluginRoot, "setup-api.js"),
    `export default {
      id: ${JSON.stringify(PLUGIN_ID)},
      register(api) {
        for (const id of ${JSON.stringify(PROVIDER_IDS)}) {
          api.registerProvider({ id, label: id, auth: [] });
        }
      }
    };\n`,
  );
  fs.writeFileSync(
    path.join(pluginRoot, "openclaw.plugin.json"),
    JSON.stringify({
      id: PLUGIN_ID,
      providers: [providerId],
      setup: { providers: [{ id: providerId }], requiresRuntime: true },
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
  );
  const snapshot = loadPluginMetadataSnapshot({
    config: fixture.config,
    workspaceDir,
    env: process.env,
    preferPersisted: false,
  });
  expect(snapshot.plugins.map((plugin) => plugin.id)).toEqual([PLUGIN_ID]);
  return { config: fixture.config, workspaceDir, snapshot, providerId };
}

function withOwner<T>(owner: ReturnType<typeof prepareOwner>, run: () => T): T {
  return withPluginMetadataSnapshotScope(owner.snapshot, run, {
    config: owner.config,
    workspaceDir: owner.workspaceDir,
    env: process.env,
  });
}

function expectOwnerSetup(owner: ReturnType<typeof prepareOwner>) {
  // process.env is intentional: custom env objects disable both setup caches.
  const params = {
    config: owner.config,
    workspaceDir: owner.workspaceDir,
    env: process.env,
    pluginIds: [PLUGIN_ID],
  };
  const otherProviderId = owner.providerId === "old-provider" ? "new-provider" : "old-provider";
  expect(resolvePluginSetupProvider({ ...params, provider: owner.providerId })?.id).toBe(
    owner.providerId,
  );
  expect(resolvePluginSetupProvider({ ...params, provider: otherProviderId })).toBeUndefined();
  // Exercise the full setup registry result cache as well as its manifest cache.
  expect(
    resolvePluginSetupRegistry(params).diagnostics.map(({ code, runtimeId }) => ({
      code,
      runtimeId,
    })),
  ).toEqual([
    {
      code: "setup-descriptor-provider-runtime-undeclared",
      runtimeId: otherProviderId,
    },
  ]);
}

describe("setup registry metadata owner scopes", () => {
  beforeEach(() => {
    clearPluginMetadataLifecycleCaches();
  });

  afterEach(() => {
    clearPluginMetadataLifecycleCaches();
    vi.unstubAllEnvs();
    cleanupTrackedTempDirs(tempRoots);
  });

  it.each(["old-first", "new-first"] as const)(
    "isolates overlapping generations at the same workspace (%s)",
    async (order) => {
      const fixture = createFixture();
      const oldOwner = prepareOwner(fixture, "workspace", "old-provider");
      const resumeOld = createDeferred();
      const oldRun = withOwner(oldOwner, async () => {
        await resumeOld.promise;
        expectOwnerSetup(oldOwner);
      });

      clearPluginMetadataLifecycleCaches();
      const newOwner = prepareOwner(fixture, "workspace", "new-provider");
      setCurrentPluginMetadataSnapshot(newOwner.snapshot, {
        config: newOwner.config,
        workspaceDir: newOwner.workspaceDir,
        env: process.env,
      });
      try {
        if (order === "new-first") {
          withOwner(newOwner, () => expectOwnerSetup(newOwner));
        }
      } finally {
        resumeOld.resolve();
        await oldRun;
      }
      withOwner(newOwner, () => expectOwnerSetup(newOwner));
    },
  );

  it("keeps explicit workspace selection and omitted-workspace discovery separate", () => {
    const fixture = createFixture();
    const ownerA = prepareOwner(fixture, "workspace-a", "old-provider");
    const ownerB = prepareOwner(fixture, "workspace-b", "new-provider");
    setCurrentPluginMetadataSnapshot(ownerB.snapshot, {
      config: ownerB.config,
      workspaceDir: ownerB.workspaceDir,
      env: process.env,
    });

    withOwner(ownerA, () => {
      expectOwnerSetup(ownerB);
      expectOwnerSetup(ownerA);
      expect(
        resolvePluginSetupProvider({
          provider: ownerA.providerId,
          config: fixture.config,
          env: process.env,
        }),
      ).toBeUndefined();
      expectOwnerSetup(ownerA);
    });
  });
});
