import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as preparedRuntime from "../../agents/prepared-model-runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import type { SkillHistoryScanCandidate } from "./history-scan-candidates.js";

const mocks = vi.hoisted(() => ({
  candidates: [] as SkillHistoryScanCandidate[],
  readSession: vi.fn(),
  review: vi.fn(),
}));

vi.mock("./history-scan-candidates.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./history-scan-candidates.js")>()),
  listHistoryScanCandidates: () => mocks.candidates,
}));
vi.mock("./history-scan-transcript.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./history-scan-transcript.js")>()),
  readHistoryScanSession: (...args: unknown[]) => mocks.readSession(...args),
}));
vi.mock("./history-scan-review.js", () => ({
  HISTORY_SCAN_SESSION_SEGMENT: "skill-workshop-history-scan",
  runSkillHistoryScanReview: (...args: unknown[]) => mocks.review(...args),
}));
import {
  HISTORY_SCAN_SESSION_OVERHEAD_CHARS,
  resolveSkillHistoryScanTranscriptBudget,
} from "./history-scan-transcript.js";
import { runSkillHistoryScan } from "./history-scan.js";

function resetRuntimeOwners() {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.preparedModelRuntimeTestApi")
  ] as { resetPreparedModelRuntimeSnapshotsForTest(): void };
  api.resetPreparedModelRuntimeSnapshotsForTest();
}

afterEach(() => {
  resetRuntimeOwners();
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  mocks.candidates = [];
});

describe("Skill Workshop history scan runtime admission", () => {
  it.each([
    "gateway",
    "standalone",
    "reloaded-config",
    "unknown-agent",
    "empty",
    "unreadable",
    "store-failure",
  ] as const)("admits history scan metadata through its runtime owner: %s", async (scenario) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "workshop-runtime-")));
    const workspaceDir = path.join(root, "workspace");
    const agentDir = path.join(root, "agent");
    await fs.mkdir(workspaceDir);
    await fs.mkdir(agentDir);
    const config: OpenClawConfig = {
      plugins: { enabled: false },
      agents: {
        defaults: { model: "workshop-test/model", workspace: workspaceDir },
        list: [{ id: "history-agent", agentDir, workspace: workspaceDir }],
      },
      models: {
        providers: {
          "workshop-test": {
            baseUrl: "https://example.invalid/v1",
            api: "openai-completions",
            models: [
              {
                id: "model",
                name: "Workshop test",
                contextWindow: 32768,
                maxTokens: 1024,
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
      session: { store: path.join(root, "sessions.json") },
    };
    const updatedAtMs = Date.parse("2026-07-16T12:00:00Z");
    mocks.candidates = [
      {
        instanceId: "one",
        sessionKey: "agent:history-agent:main",
        updatedAtMs,
        entry: { sessionId: "one", updatedAt: updatedAtMs },
      },
    ];
    mocks.readSession.mockResolvedValue({
      instanceId: "one",
      sessionKey: "agent:history-agent:main",
      updatedAt: new Date(updatedAtMs).toISOString(),
      modelIterations: 6,
      transcript: "completed work",
    });
    mocks.review.mockImplementation(async ({ onComplete }) => {
      await onComplete(0);
      return 0;
    });
    if (scenario === "empty") {
      mocks.candidates = [];
    }
    if (scenario === "unreadable") {
      mocks.readSession.mockResolvedValue(undefined);
    }
    const acquire = preparedRuntime.acquireAgentRunPreparedModelRuntime;
    const releases: Array<ReturnType<typeof vi.fn>> = [];
    const acquireSpy = vi
      .spyOn(preparedRuntime, "acquireAgentRunPreparedModelRuntime")
      .mockImplementation(async (...args) => {
        const lease = await acquire(...args);
        const release = vi.fn(lease.release);
        releases.push(release);
        return {
          snapshot:
            scenario === "store-failure"
              ? {
                  ...lease.snapshot,
                  createStores: () => {
                    throw new Error("store creation failed");
                  },
                }
              : lease.snapshot,
          release,
        };
      });
    try {
      await withEnvAsync(
        { OPENCLAW_STATE_DIR: path.join(root, "state"), OPENCLAW_HOME: root },
        async () => {
          if (scenario !== "standalone") {
            await preparedRuntime.refreshPreparedModelRuntimeSnapshots(config, {
              gatewayLifecycle: true,
              allowGatewaySubagentBinding: true,
              catalogMode: "static",
              defaultWorkspaceDir: workspaceDir,
            });
          }
          const requestConfig =
            scenario === "reloaded-config"
              ? {
                  ...config,
                  agents: {
                    ...config.agents,
                    defaults: { ...config.agents?.defaults, model: "workshop-test/retired" },
                  },
                }
              : config;
          const scan = runSkillHistoryScan({
            agentId: scenario === "unknown-agent" ? "unpublished-agent" : "history-agent",
            config: requestConfig,
            workspaceDir,
          });
          if (scenario === "unknown-agent" || scenario === "store-failure") {
            await expect(scan).rejects.toThrow(
              scenario === "unknown-agent"
                ? "prepared model runtime owner was not committed"
                : "store creation failed",
            );
            expect(mocks.review).not.toHaveBeenCalled();
          } else {
            await expect(scan).resolves.toMatchObject({
              lastScanReviewed: scenario === "empty" || scenario === "unreadable" ? 0 : 1,
            });
            if (scenario === "empty") {
              expect(acquireSpy).not.toHaveBeenCalled();
            } else {
              expect(mocks.readSession).toHaveBeenCalledWith(
                expect.objectContaining({
                  maxTranscriptChars:
                    resolveSkillHistoryScanTranscriptBudget(32768) -
                    HISTORY_SCAN_SESSION_OVERHEAD_CHARS,
                }),
              );
              if (scenario !== "unreadable") {
                expect(mocks.review).toHaveBeenCalledWith(
                  expect.objectContaining({
                    config,
                    modelRef: { provider: "workshop-test", model: "model" },
                  }),
                );
              }
            }
          }
          if (scenario === "empty" || scenario === "unreadable") {
            expect(mocks.review).not.toHaveBeenCalled();
          }
          expect(releases).toHaveLength(
            scenario === "empty" || scenario === "unknown-agent" ? 0 : 1,
          );
          for (const release of releases) {
            expect(release).toHaveBeenCalledOnce();
          }
        },
      );
    } finally {
      resetRuntimeOwners();
      closeOpenClawStateDatabaseForTest();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
