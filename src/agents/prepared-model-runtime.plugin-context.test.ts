import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import * as pluginMetadata from "../plugins/plugin-metadata-snapshot.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { requireActivePluginRegistry } from "../plugins/runtime.js";
import { resolveProviderAuthLookupMaps } from "../secrets/provider-env-vars.js";
import { createDeferred } from "../test-utils/deferred.js";
import { isAmbientCredentialAllowedByProviderAuthPin } from "./auth-profiles/ambient-auth.js";
import { resolveEnvApiKey } from "./model-auth-env.js";
import {
  prepareOwnedPluginLoadContext,
  withPreparedModelRuntimeScope,
} from "./prepared-model-runtime.plugin-context.js";
import { resolveProviderIdForAuth } from "./provider-auth-aliases.js";
import { projectProviderModelRouteConfig } from "./provider-model-route.js";

const PLUGIN_ID = "prepared-owner-env";
const PROVIDER_ID = "prepared-owner-provider";
const tempRoots: string[] = [];

function createFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "prepared-owner-metadata-")));
  tempRoots.push(root);
  const home = path.join(root, "home");
  const stateDir = path.join(root, "state");
  const bundledDir = path.join(root, "bundled");
  for (const dir of [home, stateDir, bundledDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    OPENCLAW_STATE_DIR: stateDir,
    // The fixture has no bundled runtime: only its generated workspace manifests participate.
    OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
    OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
    PREPARED_OWNER_A_KEY: "credential-a",
    PREPARED_OWNER_B_KEY: "credential-b",
    PREPARED_OWNER_REPLACEMENT_KEY: "credential-replacement",
  };
  const config: OpenClawConfig = { plugins: { allow: [PLUGIN_ID] } };
  return { root, env, config };
}

function writeProviderManifest(
  pluginRoot: string,
  envVar: string,
  providerAuthAliases?: Record<string, string>,
) {
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
  fs.writeFileSync(
    path.join(pluginRoot, "openclaw.plugin.json"),
    JSON.stringify({
      id: PLUGIN_ID,
      providers: [PROVIDER_ID],
      setup: { providers: [{ id: PROVIDER_ID, envVars: [envVar] }] },
      ...(providerAuthAliases ? { providerAuthAliases } : {}),
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
  );
}

function prepareOwner(
  fixture: ReturnType<typeof createFixture>,
  name: string,
  envVar: string,
  providerAuthAliases?: Record<string, string>,
) {
  const workspaceDir = path.join(fixture.root, name);
  const pluginRoot = path.join(workspaceDir, ".openclaw", "extensions", PLUGIN_ID);
  writeProviderManifest(pluginRoot, envVar, providerAuthAliases);
  const pluginRegistry = createEmptyPluginRegistry();
  const metadataSnapshot = prepareOwnedPluginLoadContext(
    {
      agentId: name,
      agentDir: path.join(fixture.root, `agent-${name}`),
      config: fixture.config,
      workspaceDir,
    },
    fixture.env,
    pluginRegistry,
  );
  expect(metadataSnapshot.plugins.map((plugin) => plugin.id)).toEqual([PLUGIN_ID]);
  const owner = Object.freeze({
    config: fixture.config,
    workspaceDir,
    metadataSnapshot,
    pluginRegistry,
  });
  return { owner, pluginRoot };
}

describe("prepared model runtime plugin context", () => {
  beforeEach(() => {
    clearPluginMetadataLifecycleCaches();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearPluginMetadataLifecycleCaches();
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reuses owned metadata for real env-auth reads without freezing current credentials", () => {
    const fixture = createFixture();
    const { owner } = prepareOwner(fixture, "first", "PREPARED_OWNER_A_KEY");
    // Call through the actual materializer; counting a facade mock would miss nested rescans.
    const materializations = vi.spyOn(pluginMetadata, "loadPluginMetadataSnapshot");
    const lookup = () =>
      resolveEnvApiKey(PROVIDER_ID, fixture.env, {
        config: fixture.config,
        workspaceDir: owner.workspaceDir,
      });

    for (let read = 0; read < 3; read += 1) {
      expect(lookup()).toEqual({ apiKey: "credential-a", source: "env: PREPARED_OWNER_A_KEY" });
    }
    expect(materializations).toHaveBeenCalledTimes(3);
    materializations.mockClear();

    withPreparedModelRuntimeScope(owner, () => {
      expect(requireActivePluginRegistry()).toBe(owner.pluginRegistry);
      for (let read = 0; read < 3; read += 1) {
        expect(lookup()).toEqual({ apiKey: "credential-a", source: "env: PREPARED_OWNER_A_KEY" });
      }
      fixture.env.PREPARED_OWNER_A_KEY = "credential-updated";
      expect(lookup()).toEqual({
        apiKey: "credential-updated",
        source: "env: PREPARED_OWNER_A_KEY",
      });
      delete fixture.env.PREPARED_OWNER_A_KEY;
      expect(lookup()).toBeNull();
    });

    expect(materializations).not.toHaveBeenCalled();
    expect(
      getCurrentPluginMetadataSnapshot({
        config: fixture.config,
        env: fixture.env,
        workspaceDir: owner.workspaceDir,
      }),
    ).toBeUndefined();
  });

  it("keeps interleaved owners on their workspace metadata and registry", async () => {
    const fixture = createFixture();
    const first = prepareOwner(fixture, "first", "PREPARED_OWNER_A_KEY").owner;
    const second = prepareOwner(fixture, "second", "PREPARED_OWNER_B_KEY").owner;
    const materializations = vi.spyOn(pluginMetadata, "loadPluginMetadataSnapshot");
    const firstEntered = createDeferred();
    const secondEntered = createDeferred();
    const releaseFirst = createDeferred();
    const releaseSecond = createDeferred();
    const checkFirst = () => {
      expect(requireActivePluginRegistry()).toBe(first.pluginRegistry);
      expect(resolveEnvApiKey(PROVIDER_ID, fixture.env)).toEqual({
        apiKey: "credential-a",
        source: "env: PREPARED_OWNER_A_KEY",
      });
    };
    const checkSecond = () => {
      expect(requireActivePluginRegistry()).toBe(second.pluginRegistry);
      expect(resolveEnvApiKey(PROVIDER_ID, fixture.env)).toEqual({
        apiKey: "credential-b",
        source: "env: PREPARED_OWNER_B_KEY",
      });
    };
    const firstRun = withPreparedModelRuntimeScope(first, async () => {
      firstEntered.resolve();
      await releaseFirst.promise;
      checkFirst();
    });
    await firstEntered.promise;
    const secondRun = withPreparedModelRuntimeScope(second, async () => {
      secondEntered.resolve();
      await releaseSecond.promise;
      checkSecond();
    });
    await secondEntered.promise;
    releaseFirst.resolve();
    await firstRun;
    releaseSecond.resolve();
    await secondRun;

    expect(materializations).not.toHaveBeenCalled();
  });

  it("shares route-projected metadata while applying current policy to runtime fallbacks", () => {
    const fixture = createFixture();
    const { owner } = prepareOwner(fixture, "first", "PREPARED_OWNER_A_KEY");
    const routeConfig = projectProviderModelRouteConfig({
      config: fixture.config,
      provider: PROVIDER_ID,
      route: {
        api: "openai-completions",
        baseUrl: "https://provider.invalid/api",
        authRequirement: "api-key",
        requestTransportOverrides: "none",
      },
    });
    const deniedConfig: OpenClawConfig = {
      ...routeConfig,
      plugins: { ...routeConfig.plugins, deny: [PLUGIN_ID] },
    };
    const materializations = vi.spyOn(pluginMetadata, "loadPluginMetadataSnapshot");

    expect(routeConfig).not.toEqual(fixture.config);
    withPreparedModelRuntimeScope(owner, () => {
      expect(
        resolveEnvApiKey(PROVIDER_ID, fixture.env, {
          config: routeConfig,
          workspaceDir: owner.workspaceDir,
        }),
      ).toEqual({ apiKey: "credential-a", source: "env: PREPARED_OWNER_A_KEY" });
      expect(materializations).not.toHaveBeenCalled();
      expect(
        resolveProviderAuthLookupMaps({
          config: routeConfig,
          env: fixture.env,
          workspaceDir: owner.workspaceDir,
        }).setupProviderFallbackRefs,
      ).toContain(PROVIDER_ID);
      expect(
        getCurrentPluginMetadataSnapshot({
          config: deniedConfig,
          env: fixture.env,
          workspaceDir: owner.workspaceDir,
        }),
      ).toBeUndefined();
      // Env-var names are discovery hints even for disabled plugins. Runtime fallback
      // eligibility is policy-sensitive and must be recomputed from the caller's config.
      expect(
        resolveProviderAuthLookupMaps({
          config: deniedConfig,
          env: fixture.env,
          workspaceDir: owner.workspaceDir,
        }).setupProviderFallbackRefs,
      ).not.toContain(PROVIDER_ID);
    });
  });

  it("keeps a leased generation stable while a replacement owner becomes available", async () => {
    const fixture = createFixture();
    const first = prepareOwner(fixture, "first", "PREPARED_OWNER_A_KEY");
    const entered = createDeferred();
    const resume = createDeferred();
    const oldRun = withPreparedModelRuntimeScope(first.owner, async () => {
      entered.resolve();
      await resume.promise;
      expect(resolveEnvApiKey(PROVIDER_ID, fixture.env)).toEqual({
        apiKey: "credential-a",
        source: "env: PREPARED_OWNER_A_KEY",
      });
    });
    await entered.promise;
    clearPluginMetadataLifecycleCaches();
    const replacement = prepareOwner(fixture, "first", "PREPARED_OWNER_REPLACEMENT_KEY");
    expect(replacement.owner.metadataSnapshot).not.toBe(first.owner.metadataSnapshot);
    const materializations = vi.spyOn(pluginMetadata, "loadPluginMetadataSnapshot");
    await withPreparedModelRuntimeScope(replacement.owner, async () => {
      await Promise.resolve();
      expect(resolveEnvApiKey(PROVIDER_ID, fixture.env)).toEqual({
        apiKey: "credential-replacement",
        source: "env: PREPARED_OWNER_REPLACEMENT_KEY",
      });
    });
    resume.resolve();
    await oldRun;

    expect(materializations).not.toHaveBeenCalled();
  });

  it.each(["old-first", "new-first"])(
    "keeps auth aliases and pins within overlapping generations (%s)",
    async (order) => {
      const fixture = createFixture();
      fixture.config.models = {
        providers: {
          "old-target": { baseUrl: "https://old.invalid/v1", auth: "oauth", models: [] },
          "new-target": { baseUrl: "https://new.invalid/v1", auth: "api-key", models: [] },
        },
      };
      const first = prepareOwner(fixture, "first", "PREPARED_OWNER_A_KEY", {
        "generation-alias": "old-target",
      }).owner;
      const entered = createDeferred();
      const resume = createDeferred();
      const lookup = () => {
        const params = {
          config: fixture.config,
          env: fixture.env,
          workspaceDir: first.workspaceDir,
        };
        const allowed = (type: "oauth" | "api_key") =>
          isAmbientCredentialAllowedByProviderAuthPin({
            config: fixture.config,
            authAliasLookupParams: { env: fixture.env, workspaceDir: first.workspaceDir },
            provider: "generation-alias",
            type,
          });
        return {
          alias: resolveProviderIdForAuth("generation-alias", params),
          oauthAllowed: allowed("oauth"),
          apiKeyAllowed: allowed("api_key"),
        };
      };
      const oldRun = withPreparedModelRuntimeScope(first, async () => {
        entered.resolve();
        await resume.promise;
        return lookup();
      });
      await entered.promise;
      clearPluginMetadataLifecycleCaches();
      const replacement = prepareOwner(fixture, "first", "PREPARED_OWNER_REPLACEMENT_KEY", {
        "generation-alias": "new-target",
      }).owner;
      const materializations = vi.spyOn(pluginMetadata, "loadPluginMetadataSnapshot");
      let oldResult: ReturnType<typeof lookup>;
      let newResult: ReturnType<typeof lookup>;
      if (order === "old-first") {
        resume.resolve();
        oldResult = await oldRun;
        newResult = withPreparedModelRuntimeScope(replacement, lookup);
      } else {
        newResult = withPreparedModelRuntimeScope(replacement, lookup);
        resume.resolve();
        oldResult = await oldRun;
      }
      expect(oldResult).toEqual({ alias: "old-target", oauthAllowed: true, apiKeyAllowed: false });
      expect(newResult).toEqual({ alias: "new-target", oauthAllowed: false, apiKeyAllowed: true });
      expect(materializations).not.toHaveBeenCalled();
    },
  );

  it("keeps implicit-workspace auth aliases within the active owner", () => {
    const fixture = createFixture();
    const first = prepareOwner(fixture, "first", "PREPARED_OWNER_A_KEY", {
      "workspace-alias": "first-target",
    }).owner;
    const second = prepareOwner(fixture, "second", "PREPARED_OWNER_B_KEY", {
      "workspace-alias": "second-target",
    }).owner;
    const materializations = vi.spyOn(pluginMetadata, "loadPluginMetadataSnapshot");
    const lookup = () =>
      resolveProviderIdForAuth("workspace-alias", { config: fixture.config, env: fixture.env });

    expect(withPreparedModelRuntimeScope(first, lookup)).toBe("first-target");
    expect(withPreparedModelRuntimeScope(second, lookup)).toBe("second-target");
    expect(withPreparedModelRuntimeScope(first, lookup)).toBe("first-target");
    expect(materializations).not.toHaveBeenCalled();
  });

  it("restores the parent owner and cleans up after an asynchronous failure", async () => {
    const fixture = createFixture();
    const first = prepareOwner(fixture, "first", "PREPARED_OWNER_A_KEY").owner;
    const second = prepareOwner(fixture, "second", "PREPARED_OWNER_B_KEY").owner;
    const materializations = vi.spyOn(pluginMetadata, "loadPluginMetadataSnapshot");
    const failure = new Error("nested preparation failed");

    await withPreparedModelRuntimeScope(first, async () => {
      await expect(
        withPreparedModelRuntimeScope(second, async () => {
          await Promise.resolve();
          expect(requireActivePluginRegistry()).toBe(second.pluginRegistry);
          expect(resolveEnvApiKey(PROVIDER_ID, fixture.env)?.apiKey).toBe("credential-b");
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(requireActivePluginRegistry()).toBe(first.pluginRegistry);
      expect(resolveEnvApiKey(PROVIDER_ID, fixture.env)?.apiKey).toBe("credential-a");
    });

    expect(materializations).not.toHaveBeenCalled();
    for (const owner of [first, second]) {
      expect(
        getCurrentPluginMetadataSnapshot({
          config: fixture.config,
          env: fixture.env,
          workspaceDir: owner.workspaceDir,
        }),
      ).toBeUndefined();
    }
  });
});
