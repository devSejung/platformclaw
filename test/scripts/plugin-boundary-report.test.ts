// Plugin Boundary Report tests cover plugin boundary report script behavior.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createPluginBoundaryReport,
  type PluginBoundaryReportResult,
} from "../../scripts/plugin-boundary-report.js";
import * as compatRegistry from "../../src/plugins/compat/registry.js";

function requirePluginSdkSummary(summary: {
  pluginSdk?: {
    crossOwnerReservedImportCount?: unknown;
    unusedReservedCount?: unknown;
  };
}) {
  if (!summary.pluginSdk) {
    throw new Error("Expected plugin SDK summary");
  }
  return summary.pluginSdk;
}

describe("plugin-boundary-report", () => {
  let summaryResult: PluginBoundaryReportResult;

  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-09T00:00:00Z"));
    summaryResult = createPluginBoundaryReport([
      "--summary",
      "--json",
      "--fail-on-cross-owner",
      "--fail-on-unclassified-unused-reserved",
      "--fail-on-eligible-compat",
    ]);
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it("emits compact CI-safe summary JSON", () => {
    const summary = JSON.parse(summaryResult.stdout) as {
      compat?: {
        eligibleForRemovalCount?: unknown;
        removalPendingCount?: unknown;
        removalPendingDueCount?: unknown;
        removalPending?: Array<{
          code?: unknown;
          removeAfter?: unknown;
          blocker?: unknown;
          readerCount?: unknown;
          readerSample?: unknown;
          dueForReview?: unknown;
        }>;
      };
      pluginSdk?: {
        crossOwnerReservedImportCount?: unknown;
        unusedReservedCount?: unknown;
      };
      memoryHostSdk?: {
        implementation?: unknown;
      };
    };

    expect(summaryResult.exitCode).toBe(0);
    expect(summaryResult.stderr).toBe("");
    expect(summary.compat?.eligibleForRemovalCount).toBe(0);
    expect(summary.compat?.removalPendingCount).toBe(25);
    expect(summary.compat?.removalPendingDueCount).toEqual(expect.any(Number));
    expect(summary.compat?.removalPending?.map((record) => record.code)).toEqual([
      "sdk-untrusted-context-identifier-aliases",
      "plugin-sdk-channel-logging-subpath",
      "plugin-sdk-channel-secret-runtime-subpath",
      "plugin-sdk-channel-streaming-subpath",
      "plugin-sdk-group-access-subpath",
      "plugin-sdk-inbound-reply-dispatch-subpath",
      "plugin-sdk-matrix-subpath",
      "plugin-sdk-agent-config-primitives-subpath",
      "plugin-sdk-media-understanding-public-demotion",
      "plugin-sdk-memory-host-core-public-demotion",
      "plugin-sdk-text-runtime-subpath",
      "plugin-sdk-zod-subpath",
      "agent-harness-terminal-result-aliases",
      "message-presentation-legacy-bridges",
      "official-plugin-export-aliases",
      "plugin-sdk-channel-setup-input-fields",
      "plugin-runtime-api-compat-aliases",
      "plugin-provider-manifest-compat-aliases",
      "plugin-sdk-provider-owned-helper-shims",
      "media-legacy-projection",
      "memory-host-compatibility-aliases",
      "plugin-sdk-broad-runtime-barrels",
      "plugin-sdk-focused-compat-aliases",
      "deprecated-session-store-beta5-api",
      "plugin-sdk-plugin-config-runtime-public-demotion",
    ]);
    for (const record of summary.compat?.removalPending ?? []) {
      expect(record.removeAfter).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
      expect(record.blocker).toEqual(expect.stringMatching(/retain|replacement|blocked/iu));
      expect(typeof record.readerCount).toBe("number");
      if (typeof record.readerCount !== "number") {
        throw new TypeError("Expected compatibility readerCount to be a number");
      }
      expect(record.readerSample).toEqual(expect.any(Array));
      if (record.readerCount > 0) {
        expect(record.readerSample).toEqual(expect.arrayContaining([expect.any(String)]));
      }
      expect((record.readerSample as unknown[]).length).toBeLessThanOrEqual(5);
      expect(record.dueForReview).toEqual(expect.any(Boolean));
    }
    const pluginSdk = requirePluginSdkSummary(summary);
    expect(pluginSdk.crossOwnerReservedImportCount).toBe(0);
    expect(pluginSdk.unusedReservedCount).toBe(0);
    expect(["private-core-bridge", "private-package-core-integrated"]).toContain(
      summary.memoryHostSdk?.implementation,
    );
  });

  it("renders removal-pending blockers and reader references without changing fail gates", () => {
    const result = createPluginBoundaryReport(["--summary"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("removalPending=25");
    expect(result.stdout).not.toContain("agent-harness-sdk-alias");
    expect(result.stdout).toMatch(/blocker=.*retain the public/iu);
    expect(result.stdout).toMatch(/readerRefs=\d+ readers=/u);
  });

  it("reports the elapsed conditional beta.5 window and its outstanding blockers", () => {
    vi.setSystemTime(new Date("2026-10-13T00:00:00Z"));
    try {
      const result = createPluginBoundaryReport([
        "--summary",
        "--json",
        "--fail-on-eligible-compat",
      ]);
      const summary = JSON.parse(result.stdout) as {
        compat: {
          removalPending: Array<{
            code: string;
            removeAfter?: string;
            dueForReview: boolean;
            blocker: string;
            readerCount: number;
          }>;
        };
      };
      const pending = summary.compat.removalPending.find(
        (record) => record.code === "deprecated-session-store-beta5-api",
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(pending).toMatchObject({ removeAfter: "2026-10-12", dueForReview: true });
      expect(pending?.blocker).toContain("minimum supported plugin exclusion");
      expect(pending?.blocker).toContain("legacy doctor upgrade window");
      expect(pending?.blocker).toContain("explicit breaking-release approval");
      expect(pending?.readerCount).toBeGreaterThan(0);
    } finally {
      vi.setSystemTime(new Date("2026-10-09T00:00:00Z"));
    }
  });

  it("still fails CI when an unconditional deprecated fixture window expires", () => {
    const records = compatRegistry.listPluginCompatRecords();
    const conditional = records.find(
      (record) => record.code === "deprecated-session-store-beta5-api",
    );
    if (!conditional) {
      throw new Error("Expected the retained beta.5 compatibility record");
    }
    const unconditional: (typeof records)[number] = { ...conditional, status: "deprecated" };
    // Exercise the unchanged unconditional gate independently of the retained
    // production contract, whose published-reader conditions remain unverified.
    const registry = vi
      .spyOn(compatRegistry, "listPluginCompatRecords")
      .mockReturnValue(records.map((record) => (record === conditional ? unconditional : record)));
    vi.setSystemTime(new Date("2026-10-13T00:00:00Z"));
    try {
      const result = createPluginBoundaryReport([
        "--summary",
        "--json",
        "--fail-on-eligible-compat",
      ]);
      const summary = JSON.parse(result.stdout) as {
        compat: { eligibleForRemoval: Array<{ code: string }>; removalPendingCount: number };
      };

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("1 compatibility record(s) are due for removal");
      expect(summary.compat.eligibleForRemoval.map((record) => record.code)).toEqual([
        "deprecated-session-store-beta5-api",
      ]);
      expect(summary.compat.removalPendingCount).toBe(24);
    } finally {
      registry.mockRestore();
      vi.setSystemTime(new Date("2026-10-09T00:00:00Z"));
    }
  });
});
