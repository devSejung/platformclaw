import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAgentDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

const mocks = vi.hoisted(() => ({
  ensureAuthProfileStore: vi.fn(),
  listProviderUsagePluginDescriptors: vi.fn(),
  loadProviderUsageSummary: vi.fn(),
}));

vi.mock("../../agents/auth-profiles.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/auth-profiles.js")>(
    "../../agents/auth-profiles.js",
  );
  return {
    ...actual,
    ensureAuthProfileStore: mocks.ensureAuthProfileStore,
    externalCliDiscoveryForConfigStatus: vi.fn(() => undefined),
  };
});

vi.mock("../../plugins/provider-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../../plugins/provider-runtime.js")>(
    "../../plugins/provider-runtime.js",
  );
  return {
    ...actual,
    listProviderUsagePluginDescriptors: mocks.listProviderUsagePluginDescriptors,
  };
});

vi.mock("../../infra/provider-usage.load.js", () => ({
  loadProviderUsageSummary: mocks.loadProviderUsageSummary,
}));

import {
  clearModelAuthStatusUsageCache,
  fingerprintProviderUsageCredentials,
  readProviderUsageStaleWhileRevalidate,
} from "./models-auth-status-usage-cache.js";
import { usageHandlers } from "./usage.js";

const config = {
  agents: { list: [{ id: "main", default: true }] },
} as OpenClawConfig;

function createStore(access = "access-one") {
  return {
    version: 1,
    profiles: {
      "openai:default": {
        type: "oauth" as const,
        provider: "openai",
        access,
        refresh: "refresh-one",
        expires: 1_000_000,
      },
    },
  };
}

async function runUsageStatus(
  params: { agentId?: unknown } = {},
  scopedConfig: OpenClawConfig = config,
  models: unknown[] = [{ provider: "openai" }],
) {
  const respond = vi.fn();
  await expectDefined(
    usageHandlers["usage.status"],
    'usageHandlers["usage.status"] test invariant',
  )({
    respond,
    params,
    context: {
      getRuntimeConfig: () => scopedConfig,
      readChatMetadata: async () => ({ models }),
    },
  } as unknown as Parameters<(typeof usageHandlers)["usage.status"]>[0]);
  expect(respond).toHaveBeenCalledTimes(1);
  expect(respond.mock.calls[0]?.[0]).toBe(true);
  return expectDefined(respond.mock.calls[0]?.[1], "usage.status result");
}

describe("usage.status provider usage cache", () => {
  let now = 1_000;
  let store = createStore();

  beforeEach(() => {
    now = 1_000;
    store = createStore();
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.clearAllMocks();
    clearModelAuthStatusUsageCache();
    mocks.ensureAuthProfileStore.mockImplementation(() => store);
    mocks.listProviderUsagePluginDescriptors.mockReturnValue([
      { provider: "openai", displayName: "OpenAI" },
    ]);
    mocks.loadProviderUsageSummary.mockImplementation(async () => ({
      updatedAt: now,
      providers: [
        {
          provider: "openai",
          displayName: "OpenAI",
          windows: [
            {
              label: "5h",
              usedPercent: mocks.loadProviderUsageSummary.mock.calls.length * 10,
            },
          ],
          plan: "Plus",
        },
      ],
    }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("reuses byte-identical results within 60s and refreshes stale data in the background", async () => {
    const first = await runUsageStatus();
    const repeated = await runUsageStatus();

    expect(JSON.stringify(repeated)).toBe(JSON.stringify(first));
    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledTimes(1);

    now = 61_000;
    const stale = await runUsageStatus();
    expect(JSON.stringify(stale)).toBe(JSON.stringify(first));
    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledTimes(2);

    await vi.waitFor(async () => {
      const refreshed = (await runUsageStatus()) as {
        providers: Array<{ windows: Array<{ usedPercent: number }> }>;
      };
      expect(refreshed.providers[0]?.windows[0]?.usedPercent).toBe(20);
    });
    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledTimes(2);
  });

  it("shares the raw snapshot with models.authStatus and invalidates on credential rotation", async () => {
    await runUsageStatus();
    const agentId = resolveDefaultAgentId(config);
    const agentDir = resolveAgentDir(config, agentId);
    const usage = readProviderUsageStaleWhileRevalidate({
      agentId,
      agentDir,
      configRef: config,
      credentialKey: fingerprintProviderUsageCredentials({
        cfg: config,
        directApiKeys: new Map(),
        store: store as AuthProfileStore,
      }),
      providerIds: ["openai"],
      now,
    });
    expect(usage.get("openai")?.windows[0]?.usedPercent).toBe(10);
    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledTimes(1);

    store.profiles["openai:default"].access = "access-two";
    const rotated = (await runUsageStatus()) as {
      providers: Array<{ windows: Array<{ usedPercent: number }> }>;
    };
    expect(rotated.providers[0]?.windows[0]?.usedPercent).toBe(20);
    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledTimes(2);
  });

  it("keeps interleaved Agent credential owners in separate usage caches", async () => {
    const scopedConfig: OpenClawConfig = {
      agents: { list: [{ id: "main", default: true }, { id: "personal" }] },
    };
    const mainDir = resolveAgentDir(scopedConfig, "main");
    const personalDir = resolveAgentDir(scopedConfig, "personal");
    const mainStore = createStore("main-credential");
    const personalStore = createStore("personal-credential");
    mocks.ensureAuthProfileStore.mockImplementation((agentDir: string) =>
      agentDir === personalDir ? personalStore : mainStore,
    );
    const pending = new Map<string, (usedPercent: number) => void>();
    mocks.loadProviderUsageSummary.mockImplementation(
      ({ agentDir }: { agentDir: string }) =>
        new Promise((resolve) => {
          pending.set(agentDir, (usedPercent) =>
            resolve({
              updatedAt: now,
              providers: [
                {
                  provider: "openai",
                  displayName: "OpenAI",
                  windows: [{ label: "5h", usedPercent }],
                },
              ],
            }),
          );
        }),
    );
    const main = runUsageStatus({}, scopedConfig);
    const personal = runUsageStatus({ agentId: "personal" }, scopedConfig);
    await vi.waitFor(() => expect(pending.size).toBe(2));
    expectDefined(pending.get(personalDir), "personal usage resolver")(70);
    expectDefined(pending.get(mainDir), "main usage resolver")(10);
    const [mainResult, personalResult] = await Promise.all([main, personal]);
    expect(mainResult).toMatchObject({ providers: [{ windows: [{ usedPercent: 10 }] }] });
    expect(personalResult).toMatchObject({ providers: [{ windows: [{ usedPercent: 70 }] }] });
    expect(await runUsageStatus({}, scopedConfig)).toEqual(mainResult);
    expect(await runUsageStatus({ agentId: "personal" }, scopedConfig)).toEqual(personalResult);
    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledTimes(2);
    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDir: personalDir,
        providers: ["openai"],
      }),
    );
  });

  it("limits explicit Agent quota reads to its model providers using canonical usage aliases", async () => {
    mocks.listProviderUsagePluginDescriptors.mockReturnValue([
      { provider: "openai" },
      { provider: "anthropic" },
      { provider: "zai" },
    ]);
    await runUsageStatus({ agentId: "main" }, config, [{ provider: "claude-cli" }]);
    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        providers: ["anthropic"],
      }),
    );
    mocks.loadProviderUsageSummary.mockClear();
    await runUsageStatus({}, config);
    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        providers: ["anthropic", "openai", "zai"],
      }),
    );
  });

  it.each(["other", " ", null, 42])(
    "rejects explicit unknown Agent %j before credential reads",
    async (agentId) => {
      const respond = vi.fn();
      const readChatMetadata = vi.fn();
      await expectDefined(
        usageHandlers["usage.status"],
        "usage.status handler",
      )({
        respond,
        params: { agentId },
        context: { getRuntimeConfig: () => config, readChatMetadata },
      } as unknown as Parameters<(typeof usageHandlers)["usage.status"]>[0]);
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "INVALID_REQUEST",
        }),
      );
      expect(readChatMetadata).not.toHaveBeenCalled();
      expect(mocks.ensureAuthProfileStore).not.toHaveBeenCalled();
      expect(mocks.loadProviderUsageSummary).not.toHaveBeenCalled();
    },
  );
});
