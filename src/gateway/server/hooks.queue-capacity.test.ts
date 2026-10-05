// Real HTTP hook requests must receive admission feedback from the real session queue.
import { createServer } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../../cli/deps.types.js";
import { SystemEventQueueFullError } from "../../infra/system-event-queue-error.js";
import {
  drainSystemEvents,
  enqueueSystemEvent,
  peekSystemEvents,
  resetSystemEventsForTest,
} from "../../infra/system-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { createHooksConfig } from "../hooks-test-helpers.js";
import { createGatewayHooksRequestHandler } from "./hooks.js";

const { requestHeartbeat } = vi.hoisted(() => ({ requestHeartbeat: vi.fn() }));
vi.mock("../../infra/heartbeat-wake.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/heartbeat-wake.js")>()),
  requestHeartbeat,
}));
vi.mock("../../config/io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/io.js")>()),
  getRuntimeConfig: () => ({}),
}));

const hooksConfig = createHooksConfig();
hooksConfig.mappings = [
  {
    id: "mapped-wake",
    matchPath: "mapped-wake",
    action: "wake",
    wakeMode: "now",
    agentId: "main",
    sessionKey: "agent:main:mapped",
    textTemplate: "{{payload.text}}",
  },
];
const handler = createGatewayHooksRequestHandler({
  deps: {} as CliDeps,
  getHooksConfig: () => hooksConfig,
  getClientIpConfig: () => ({}),
  bindHost: "127.0.0.1",
  port: 0,
  logHooks: createSubsystemLogger("test-hooks"),
});
const server = createServer((req, res) => {
  void handler(req, res).catch(() => {
    res.statusCode = 500;
    res.end("unexpected handler failure");
  });
});
let baseUrl: string;
beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("missing test server address");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});
afterEach(() => {
  resetSystemEventsForTest();
  requestHeartbeat.mockClear();
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

async function post(path: string, text: string) {
  const response = await fetch(`${baseUrl}/hooks/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${hooksConfig.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text, mode: "now" }),
  });
  return { status: response.status, body: await response.json() };
}

describe("hook queue admission over HTTP", () => {
  it.each([
    { path: "wake", sessionKey: "agent:main:main" },
    { path: "mapped-wake", sessionKey: "agent:main:mapped" },
  ])(
    "rejects overflow on $path and accepts caller retries after drain",
    async ({ path, sessionKey }) => {
      const texts = Array.from({ length: 23 }, (_, index) => `notification ${index}`);
      const results = [];
      for (const text of texts) {
        results.push(await post(path, text));
      }
      expect(results.slice(0, 20).map((result) => result.status)).toEqual(Array(20).fill(200));
      expect(results.slice(20)).toEqual(
        Array.from({ length: 3 }, () => ({
          status: 503,
          body: { ok: false, error: new SystemEventQueueFullError(20).message },
        })),
      );
      expect(requestHeartbeat).toHaveBeenCalledTimes(20);
      expect(peekSystemEvents(sessionKey)).toEqual(texts.slice(0, 20));
      enqueueSystemEvent("unrelated", { sessionKey: "agent:other:main" });
      expect(drainSystemEvents(sessionKey)).toEqual(texts.slice(0, 20));
      for (const text of texts.slice(20)) {
        expect((await post(path, text)).status).toBe(200);
      }
      expect(drainSystemEvents(sessionKey)).toEqual(texts.slice(20));
      expect(peekSystemEvents("agent:other:main")).toEqual(["unrelated"]);
      expect(requestHeartbeat).toHaveBeenCalledTimes(23);
    },
  );
});
