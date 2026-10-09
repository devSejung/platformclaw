// Server network runtime e2e tests verify gateway startup isolation, proxy env handling, and runtime cleanup.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import { resetAgentEventsForTest } from "../infra/agent-events.js";
import { hasProxyEnvConfigured } from "../infra/net/proxy-env.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { startGatewayServer } from "./server.js";
import { getFreeGatewayPort } from "./test-helpers.e2e.js";

const NETWORK_GATEWAY_ENV_KEYS = [
  "HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_SKIP_GMAIL_WATCHER",
  "OPENCLAW_SKIP_CRON",
  "OPENCLAW_SKIP_CANVAS_HOST",
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
  "OPENCLAW_SKIP_PROVIDERS",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_TEST_MINIMAL_GATEWAY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "no_proxy",
] as const;

function isEnvHttpProxyDispatcher(dispatcher: unknown): boolean {
  return (
    (dispatcher as { constructor?: { name?: string } } | undefined)?.constructor?.name ===
    "EnvHttpProxyAgent"
  );
}

async function closeTestDispatcher(dispatcher: unknown): Promise<void> {
  const close = (dispatcher as { close?: () => Promise<void> | void } | undefined)?.close;
  if (typeof close !== "function") {
    return;
  }
  await close.call(dispatcher);
}

describe("gateway network runtime", () => {
  beforeEach(() => {
    resetAgentEventsForTest({ preserveListeners: true });
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    clearSessionStoreCacheForTest();
  });

  afterEach(() => {
    resetAgentEventsForTest({ preserveListeners: true });
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    clearSessionStoreCacheForTest();
  });

  it("bootstraps env proxy dispatching when the gateway starts directly", async () => {
    // Probe names with a nonblank value so blank lowercase proxy shadows are also captured.
    const proxyEnvKeys = Object.keys(process.env).filter((key) =>
      hasProxyEnvConfigured({ [key]: "http://proxy.test" }),
    );
    const envKeys = [...new Set([...NETWORK_GATEWAY_ENV_KEYS, ...proxyEnvKeys])];
    const envSnapshot = captureEnv(envKeys);
    const originalDispatcher = getGlobalDispatcher();
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-proxy-home-"));
    let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;

    try {
      const testDispatcher = new Agent();
      setGlobalDispatcher(testDispatcher);
      for (const key of envKeys) {
        deleteTestEnvValue(key);
      }
      process.env.HTTPS_PROXY = "http://127.0.0.1:9";

      setTestEnvValue("HOME", tempHome);
      setTestEnvValue("OPENCLAW_STATE_DIR", path.join(tempHome, ".openclaw"));
      process.env.OPENCLAW_SKIP_CHANNELS = "1";
      process.env.OPENCLAW_SKIP_GMAIL_WATCHER = "1";
      process.env.OPENCLAW_SKIP_CRON = "1";
      process.env.OPENCLAW_SKIP_CANVAS_HOST = "1";
      process.env.OPENCLAW_SKIP_BROWSER_CONTROL_SERVER = "1";
      process.env.OPENCLAW_SKIP_PROVIDERS = "1";
      process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = "1";
      process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = path.join(tempHome, "empty-bundled-plugins");
      await fs.mkdir(process.env.OPENCLAW_BUNDLED_PLUGINS_DIR, { recursive: true });

      const token = `proxy-token-${process.pid}-${process.env.VITEST_POOL_ID ?? "0"}`;
      process.env.OPENCLAW_GATEWAY_TOKEN = token;
      const configPath = path.join(tempHome, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify({ gateway: { auth: { mode: "token", token } } }, null, 2)}\n`,
      );
      setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);

      server = await startGatewayServer(await getFreeGatewayPort(), {
        bind: "loopback",
        auth: { mode: "token", token },
        controlUiEnabled: false,
      });

      expect(isEnvHttpProxyDispatcher(getGlobalDispatcher())).toBe(true);
    } finally {
      await server?.close({ reason: "gateway proxy bootstrap test complete" });
      const dispatcherToClose = getGlobalDispatcher();
      setGlobalDispatcher(originalDispatcher);
      if (dispatcherToClose !== originalDispatcher) {
        await closeTestDispatcher(dispatcherToClose);
      }
      await fs.rm(tempHome, { recursive: true, force: true });
      envSnapshot.restore();
    }
  });
});
