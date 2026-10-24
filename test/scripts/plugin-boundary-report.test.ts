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
    expect(summary.compat?.removalPendingCount).toBe(26);
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
      "deprecated-package-root-session-store-api",
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
    expect(result.stdout).toContain("removalPending=26");
    expect(result.stdout).not.toContain("agent-harness-sdk-alias");
    expect(result.stdout).toMatch(/blocker=.*retain the public/iu);
    expect(result.stdout).toMatch(/readerRefs=\d+ readers=/u);
  });

  it.each(["2026-10-11", "2026-10-12", "2026-10-24"])(
    "keeps conditional session-store removals visible without failing CI on %s",
    (today) => {
      vi.setSystemTime(new Date(`${today}T00:00:00Z`));
      try {
        for (const mode of [[], ["--summary"]]) {
          const result = createPluginBoundaryReport([
            ...mode,
            "--json",
            "--fail-on-cross-owner",
            "--fail-on-unclassified-unused-reserved",
            "--fail-on-eligible-compat",
          ]);
          const report = JSON.parse(result.stdout) as {
            compat: {
              eligibleForRemovalCount: number;
              removalPending: Array<{
                code: string;
                removeAfter: string;
                blocker: string;
                dueForReview: boolean;
              }>;
            };
          };
          expect(result.exitCode).toBe(0);
          expect(result.stderr).toBe("");
          expect(report.compat.eligibleForRemovalCount).toBe(0);
          const pending = report.compat.removalPending.filter((record) =>
            [
              "deprecated-session-store-beta5-api",
              "deprecated-package-root-session-store-api",
            ].includes(record.code),
          );
          expect(pending).toEqual([
            expect.objectContaining({
              code: "deprecated-package-root-session-store-api",
              blocker: expect.stringContaining("legacy doctor importer"),
              removeAfter: "2026-10-12",
              dueForReview: today >= "2026-10-12",
            }),
            expect.objectContaining({
              code: "deprecated-session-store-beta5-api",
              blocker: expect.stringContaining("minimum supported plugin exclusion"),
              removeAfter: "2026-10-12",
              dueForReview: today >= "2026-10-12",
            }),
          ]);
          for (const record of pending) {
            expect(record.blocker).toContain("published-reader migration");
            expect(record.blocker).toContain("explicit breaking-release approval");
          }
          if (mode.length === 0) {
            expect(pending[0]).toHaveProperty(
              "readerFiles",
              expect.arrayContaining(["src/library.ts", "src/index.ts"]),
            );
          }
        }
      } finally {
        vi.setSystemTime(new Date("2026-10-09T00:00:00Z"));
      }
    },
  );

  it.each([
    ["2026-10-11", 0],
    ["2026-10-12", 1],
    ["2026-10-24", 1],
  ])("still enforces an unconditional removal date on %s", (today, expectedExit) => {
    const registry = vi.spyOn(compatRegistry, "listPluginCompatRecords").mockReturnValue([
      {
        code: "deprecated-session-store-beta5-api",
        status: "deprecated",
        owner: "sdk",
        introduced: "2026-05-21",
        deprecated: "2026-07-12",
        warningStarts: "2026-07-12",
        removeAfter: "2026-10-12",
        replacement: "Use the replacement API; unconditional removal approved",
        docsPath: "/plugins/compatibility",
        surfaces: ["test fixture unconditional SDK API"],
        diagnostics: ["test fixture deprecation"],
        tests: ["test/scripts/plugin-boundary-report.test.ts"],
      },
    ]);
    vi.setSystemTime(new Date(`${today}T00:00:00Z`));
    try {
      const result = createPluginBoundaryReport([
        "--summary",
        "--json",
        "--fail-on-eligible-compat",
      ]);
      const summary = JSON.parse(result.stdout) as {
        compat: { eligibleForRemoval: Array<{ code: string }> };
      };

      expect(result.exitCode).toBe(expectedExit);
      expect(result.stderr).toBe(
        expectedExit === 1
          ? "plugin-boundary-report: 1 compatibility record(s) are due for removal\n"
          : "",
      );
      expect(summary.compat.eligibleForRemoval.map((record) => record.code)).toEqual(
        expectedExit === 1 ? ["deprecated-session-store-beta5-api"] : [],
      );
    } finally {
      registry.mockRestore();
      vi.setSystemTime(new Date("2026-10-09T00:00:00Z"));
    }
  });
});
