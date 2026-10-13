import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChannelIngressQueue } from "../../channels/message/ingress-queue.js";
import { importBundledChannelContractArtifact } from "../../channels/plugins/contracts/test-helpers/runtime-artifacts.js";
import { getChannelPlugin, getLoadedChannelPlugin } from "../../channels/plugins/index.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import { registerChannelsCli } from "../../cli/channels-cli.js";
import { resolveCliCommandPathPolicy } from "../../cli/command-path-policy.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../../plugins/runtime.js";
import * as pluginRuntimeBoundary from "../../plugins/runtime/runtime-plugin-boundary.js";
import type { OpenClawPluginApi, OpenClawPluginDefinition } from "../../plugins/types.js";
import { defaultRuntime } from "../../runtime.js";
import * as stateDatabase from "../../state/openclaw-state-db.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";

const previousRegistry = getActivePluginRegistry();
const traceEnabled = process.env.OPENCLAW_TEST_KNOX_COLD_PHASE_TRACE === "1";
type ColdCaseTrace = {
  mode: string;
  startedAt: number;
  signal: AbortSignal;
  stateDir?: string;
  phase: string;
  settled: boolean;
  completion: Promise<void>;
};
type SqliteTrace = {
  calls: number;
  returns: number;
  incomplete: number;
  sameDatabase: boolean | null;
  insideFixture: boolean | null;
};
let activeTrace: ColdCaseTrace | undefined;
let testSignal: AbortSignal | undefined;
let sqliteTrace: (trace: ColdCaseTrace) => SqliteTrace;

function recordPhase(trace: ColdCaseTrace, phase: string) {
  trace.phase = phase;
  if (!traceEnabled) {
    return;
  }
  const snapshot = {
    mode: trace.mode,
    phase,
    elapsedMs: Math.round(performance.now() - trace.startedAt),
    aborted: trace.signal.aborted,
    settled: trace.settled,
    fixtureEnvMatches: trace.stateDir ? process.env.OPENCLAW_STATE_DIR === trace.stateDir : null,
    sqlite: sqliteTrace(trace),
  };
  process.stderr.write(`[knox-cold-phase] ${JSON.stringify(snapshot)}\n`);
}

async function inPhase<T>(
  trace: ColdCaseTrace,
  phase: string,
  run: () => T | Promise<T>,
): Promise<T> {
  recordPhase(trace, `${phase}:begin`);
  // Vitest timeout does not cancel the original async body. Stop new phases
  // from starting after the test signal or fixture has been restored.
  trace.signal.throwIfAborted();
  if (trace.stateDir && process.env.OPENCLAW_STATE_DIR !== trace.stateDir) {
    throw new Error("Synthetic cold CLI fixture was restored before the operation");
  }
  try {
    const result = await run();
    recordPhase(trace, `${phase}:end`);
    return result;
  } catch (error) {
    recordPhase(trace, `${phase}:failed`);
    throw error;
  }
}

describe("dead-letter CLI actual channel registration", () => {
  beforeEach((context) => {
    testSignal = context.signal;
    activeTrace = undefined;
    if (traceEnabled) {
      // A default spy calls the real opener; it supplies counters and identity
      // booleans only. Do not replace the implementation or serialize env/paths.
      const opener = vi.spyOn(stateDatabase, "openOpenClawStateDatabase");
      sqliteTrace = (trace) => {
        const paths = opener.mock.results.flatMap((result) =>
          result.type === "return" ? [result.value.path] : [],
        );
        const last = paths.at(-1);
        const relative = last && trace.stateDir ? path.relative(trace.stateDir, last) : undefined;
        return {
          calls: opener.mock.calls.length,
          returns: paths.length,
          incomplete: opener.mock.results.filter((result) => result.type === "incomplete").length,
          sameDatabase: last ? last === paths[0] : null,
          insideFixture:
            relative !== undefined
              ? !path.isAbsolute(relative) &&
                relative !== ".." &&
                !relative.startsWith(`..${path.sep}`)
              : null,
        };
      };
    }
    // Resolve the real bundled entry from this checkout, with no operator config.
    vi.stubEnv(
      "OPENCLAW_BUNDLED_PLUGINS_DIR",
      path.resolve(import.meta.dirname, "../../../extensions"),
    );
    setActivePluginRegistry(createTestRegistry([]));
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("Synthetic CLI must not access a service");
      }),
    );
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "exit").mockImplementation((code) => {
      throw new Error(`Synthetic CLI exit ${code}`);
    });
  });
  afterEach(async () => {
    if (activeTrace) {
      recordPhase(activeTrace, "cleanup:begin");
      // A timeout rejects the test wrapper, not the original async body. Keep
      // its synthetic env/DB intact until that body has finished its cleanup.
      await activeTrace.completion;
      recordPhase(activeTrace, "cleanup:work-settled");
    }
    stateDatabase.closeOpenClawStateDatabaseForTest();
    setActivePluginRegistry(previousRegistry ?? createTestRegistry([]));
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    if (activeTrace) {
      recordPhase(activeTrace, "cleanup:environment-restored");
    }
    vi.restoreAllMocks();
  }, 60_000);

  for (const mode of ["cold bundled fallback", "real entry registration"] as const) {
    // Real source-only registry/factory loading measured 143441ms. Both modes
    // call the same cold loadChannelPlugin path in a fresh process. Budget 300s
    // only for these real-cold cases; preserve assertions without warmup/mocks.
    const timeout = 300_000;
    it(
      `appends a legacy failure through Commander and ${mode}`,
      async () => {
        if (!testSignal) {
          throw new Error("Expected the Vitest test cancellation signal");
        }
        let completeCase: () => void = () => {};
        const completion = new Promise<void>((resolve) => {
          completeCase = resolve;
        });
        const trace: ColdCaseTrace = {
          mode,
          signal: testSignal,
          startedAt: performance.now(),
          phase: "case:begin",
          settled: false,
          completion,
        };
        activeTrace = trace;
        const onAbort = () => recordPhase(trace, `test:abort-during:${trace.phase}`);
        trace.signal.addEventListener("abort", onAbort, { once: true });
        let stateDir: string | undefined;
        try {
          stateDir = await inPhase(trace, "fixture:create", () =>
            fs.mkdtemp(path.join(os.tmpdir(), "knox-cold-cli-")),
          );
          trace.signal.throwIfAborted();
          trace.stateDir = stateDir;
          vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
          recordPhase(trace, "fixture:ready");
          const policy = resolveCliCommandPathPolicy(["channels", "dead-letters", "resubmit"]);
          expect(policy.loadPlugins).toBe("always");
          expect(policy.pluginRegistry.scope).toBe("configured-channels");
          expect(getLoadedChannelPlugin("knox")).toBeUndefined();
          if (mode === "real entry registration") {
            const resolveArtifact = vi.spyOn(
              pluginRuntimeBoundary,
              "resolvePluginRuntimeModulePath",
            );
            const { default: entry } = await inPhase(trace, "registry:entry-import", () =>
              importBundledChannelContractArtifact<{ default: OpenClawPluginDefinition }>(
                "knox",
                "index.js",
              ),
            );
            expect(resolveArtifact).toHaveReturnedWith(
              path.resolve(import.meta.dirname, "../../../extensions/knox/index.ts"),
            );
            const register = entry.register;
            if (!register) {
              throw new Error("Knox plugin entry registration is missing");
            }
            await inPhase(trace, "registry:entry-register", () =>
              register({
                registrationMode: "discovery",
                runtime: { config: { current: () => ({}) } },
                registerChannel: ({ plugin }: { plugin: ChannelPlugin }) => {
                  setActivePluginRegistry(
                    createTestRegistry([
                      {
                        pluginId: "knox",
                        plugin,
                        source: "synthetic-entry",
                        origin: "bundled",
                      },
                    ]),
                  );
                },
              } as unknown as OpenClawPluginApi),
            );
            expect(getLoadedChannelPlugin("knox")?.ingressQueue?.orderBy).toBe("admission");
          }
          // No getChannelPlugin/factory/entry/queue/resubmit mock: the policy is real.
          const plugin = await inPhase(trace, "registry:get-channel-plugin", () =>
            getChannelPlugin("knox"),
          );
          expect(plugin?.ingressQueue?.orderBy).toBe("admission");
          recordPhase(trace, "registry:policy-asserted");
          const legacy = createChannelIngressQueue<string>({ channelId: "knox" });
          await inPhase(trace, "sqlite:legacy-enqueue", () =>
            legacy.enqueue("F", "synthetic legacy request", { receivedAt: 1, laneKey: "room" }),
          );
          const failure = await inPhase(trace, "sqlite:legacy-claim", () => legacy.claim("F"));
          if (!failure) {
            throw new Error("Expected synthetic legacy claim");
          }
          await inPhase(trace, "sqlite:legacy-fail", () =>
            legacy.fail(failure, { reason: "synthetic" }),
          );
          const queue = createChannelIngressQueue<string>({
            channelId: "knox",
            sequencedAdmission: true,
          });
          await inPhase(trace, "sqlite:new-enqueue", () =>
            queue.enqueue("B", "synthetic new request", { receivedAt: 2, laneKey: "room" }),
          );
          const retained = await inPhase(
            trace,
            "sqlite:retained-before-cli",
            () => legacy.listFailed?.() ?? Promise.resolve([]),
          );
          expect(retained.map((item) => item.id)).toContain("F");
          recordPhase(trace, "sqlite:retained-asserted");
          const args = ["channels", "dead-letters", "resubmit", "F", "--channel", "knox"];
          const program = new Command().name("openclaw");
          program.hook("preAction", () => {
            recordPhase(trace, "cli:pre-action");
          });
          await inPhase(trace, "cli:register", () =>
            registerChannelsCli(program, ["node", "openclaw", ...args]),
          );
          await inPhase(trace, "cli:parse-and-action", () =>
            program.parseAsync(args, { from: "user" }),
          );
          const pending = await inPhase(trace, "sqlite:pending-after-cli", () =>
            queue.listPending({ orderBy: "admission" }),
          );
          expect(pending.map((item) => item.id)).toEqual(["B", "F"]);
          recordPhase(trace, "cli:order-asserted");
          expect(fetch).not.toHaveBeenCalled();
        } finally {
          try {
            recordPhase(trace, "case:finally");
            stateDatabase.closeOpenClawStateDatabaseForTest();
            if (stateDir) {
              await fs.rm(stateDir, { recursive: true, force: true });
            }
          } finally {
            trace.settled = true;
            recordPhase(trace, "case:settled");
            trace.signal.removeEventListener("abort", onAbort);
            completeCase();
          }
        }
      },
      timeout,
    );
  }
});
