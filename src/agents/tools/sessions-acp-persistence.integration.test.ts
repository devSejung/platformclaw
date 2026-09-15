import fs from "node:fs/promises";
import path from "node:path";
import type { AcpRuntime } from "@openclaw/acp-core/runtime/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testing as managerTesting } from "../../acp/control-plane/manager.js";
import { registerAcpProcessTransport } from "../../acp/runtime/process-transport.js";
import {
  registerAcpRuntimeBackend,
  testing as runtimeRegistryTesting,
} from "../../acp/runtime/registry.js";
import { readAcpSessionMeta } from "../../acp/runtime/session-meta.js";
import { createDefaultDeps } from "../../cli/deps.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../config/config.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withLocalGatewayRequestScope } from "../../gateway/local-request-context.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import { callInProcessGatewayTool } from "./in-process-gateway.js";
import { createSessionsSendTool } from "./sessions-send-tool.js";
import { createSessionsSpawnTool } from "./sessions-spawn-tool.js";

const gatewayCallMock = vi.hoisted(() => vi.fn());

vi.mock("../../gateway/call.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../gateway/call.js")>();
  return {
    ...actual,
    callGateway: (request: unknown) => gatewayCallMock(request),
  };
});

describe("persistent ACP sessions_spawn follow-up integration", () => {
  afterEach(() => {
    gatewayCallMock.mockReset();
    managerTesting.resetAcpSessionManagerForTests();
    runtimeRegistryTesting.resetAcpRuntimeBackendsForTests();
    clearConfigCache();
    clearRuntimeConfigSnapshot();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  it("keeps the created ACP lifecycle through the first task and sessions_send", async () => {
    await withTempDir({ prefix: "openclaw-acp-spawn-followup-" }, async (dir) => {
      const previousStateDir = process.env.OPENCLAW_STATE_DIR;
      const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
      process.env.OPENCLAW_STATE_DIR = dir;
      process.env.OPENCLAW_CONFIG_PATH = path.join(dir, "openclaw.json");
      try {
        const parentSessionKey = "agent:person:main";
        const storePath = path.join(dir, "sessions.json");
        const cfg = {
          acp: {
            enabled: true,
            backend: "test",
            allowedAgents: ["codex"],
            dispatch: { enabled: true },
          },
          agents: { entries: { person: { default: true, workspace: dir } } },
          session: { store: storePath },
          plugins: { enabled: false },
        } as OpenClawConfig;
        await fs.writeFile(process.env.OPENCLAW_CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`);
        clearConfigCache();
        clearRuntimeConfigSnapshot();
        await replaceSessionEntry(
          { agentId: "person", sessionKey: parentSessionKey, storePath },
          {
            sessionId: "parent-session",
            lifecycleRevision: "parent-revision",
            sessionStartedAt: Date.now(),
            updatedAt: Date.now(),
          },
        );

        const rememberedByRuntime = new Map<string, string[]>();
        const ensureSession = vi.fn<AcpRuntime["ensureSession"]>(async (input) => {
          const agentSessionId = input.resumeSessionId ?? "codex-persistent-session";
          if (!rememberedByRuntime.has(agentSessionId)) {
            rememberedByRuntime.set(agentSessionId, []);
          }
          return {
            sessionKey: input.sessionKey,
            backend: "test",
            runtimeSessionName: agentSessionId,
            agentSessionId,
          };
        });
        const runTurn = vi.fn<AcpRuntime["runTurn"]>(async function* (input) {
          const messages = rememberedByRuntime.get(input.handle.agentSessionId!)!;
          messages.push(input.text);
          yield {
            type: "text_delta" as const,
            text: messages.length === 1 ? "FIRST_OK" : "APPLE_OK",
          };
          yield { type: "done" as const, stopReason: "end_turn" };
        });
        registerAcpRuntimeBackend({
          id: "test",
          isolatesSandboxedRequesters: () => true,
          runtime: {
            ensureSession,
            runTurn,
            cancel: vi.fn(async () => {}),
            close: vi.fn(async () => {}),
          },
        });
        const unregisterTransport = registerAcpProcessTransport({
          id: "test-personal",
          isolatesSandboxedRequesters: true,
          supports: ({ executionOwnerAgentId, agent }) =>
            executionOwnerAgentId === "person" && agent === "codex",
          prepare: async () => ({ cwd: dir }),
          launch: async () => {
            throw new Error("fake ACP runtime must not launch a process transport");
          },
        });

        gatewayCallMock.mockImplementation(
          async (request: { method: string; params?: Record<string, unknown> }) =>
            await callInProcessGatewayTool(request.method, request.params ?? {}),
        );

        try {
          await withLocalGatewayRequestScope(
            { deps: createDefaultDeps(), getRuntimeConfig: () => cfg },
            async () => {
              const spawn = createSessionsSpawnTool({
                agentSessionKey: parentSessionKey,
                requesterAgentIdOverride: "person",
                config: cfg,
              });
              const spawned = await spawn.execute("spawn-persistent-acp", {
                runtime: "acp",
                agentId: "codex",
                mode: "session",
                task: "Remember APPLE. Reply FIRST_OK",
              });
              const details = spawned.details as {
                status?: string;
                childSessionKey?: string;
                runId?: string;
              };
              expect(details).toMatchObject({ status: "accepted" });
              expect(details.childSessionKey).toMatch(/^agent:person:acp:/);
              await callInProcessGatewayTool("agent.wait", {
                runId: details.runId,
                timeoutMs: 5_000,
              });
              const persistedEntry = loadSessionEntry({
                agentId: "person",
                sessionKey: details.childSessionKey!,
                storePath,
              });
              const persistedMeta = readAcpSessionMeta({
                cfg,
                sessionKey: details.childSessionKey!,
              });
              if (!persistedMeta) {
                throw new Error(`first turn lost ACP lifecycle: ${JSON.stringify(persistedEntry)}`);
              }

              const send = createSessionsSendTool({
                agentSessionKey: parentSessionKey,
                config: cfg,
                callGateway: async <T>(request: { method: string; params?: unknown }) =>
                  await callInProcessGatewayTool<T>(
                    request.method,
                    (request.params ?? {}) as Record<string, unknown>,
                  ),
              });
              const followUp = await send.execute("send-persistent-acp", {
                sessionKey: details.childSessionKey,
                message: "What should you remember?",
                timeoutSeconds: 5,
              });
              if ((followUp.details as { status?: string }).status !== "ok") {
                const failedEntry = loadSessionEntry({
                  agentId: "person",
                  sessionKey: details.childSessionKey!,
                  storePath,
                });
                throw new Error(
                  `sessions_send failed: ${JSON.stringify({ details: followUp.details, entry: failedEntry })}`,
                );
              }
              expect(followUp.details).toMatchObject({
                status: "ok",
                reply: "APPLE_OK",
                sessionKey: details.childSessionKey,
              });
            },
          );
        } finally {
          unregisterTransport();
        }

        expect(ensureSession).toHaveBeenLastCalledWith(
          expect.objectContaining({
            executionOwnerAgentId: "person",
            resumeSessionId: "codex-persistent-session",
          }),
        );
        expect(runTurn).toHaveBeenCalledTimes(2);
        expect([...rememberedByRuntime.values()][0]).toEqual([
          "Remember APPLE. Reply FIRST_OK",
          expect.stringContaining("What should you remember?"),
        ]);
      } finally {
        if (previousStateDir === undefined) {
          delete process.env.OPENCLAW_STATE_DIR;
        } else {
          process.env.OPENCLAW_STATE_DIR = previousStateDir;
        }
        if (previousConfigPath === undefined) {
          delete process.env.OPENCLAW_CONFIG_PATH;
        } else {
          process.env.OPENCLAW_CONFIG_PATH = previousConfigPath;
        }
      }
    });
  });
});
