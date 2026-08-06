import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  resolve(import.meta.dirname, "../../.github/workflows/platformclaw-submission.yml"),
  "utf8",
);
const finalGate = readFileSync(
  resolve(import.meta.dirname, "../../scripts/submission/verify-final.mjs"),
  "utf8",
);

describe("PlatformClaw submission workflow", () => {
  it("runs the external gate for both submission branches and pull requests", () => {
    expect(workflow).toContain("submission/hello-ai-2026-prep");
    expect(workflow).toContain("submission/hello-ai-2026-final");
    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("pnpm submission:test:mock");
    expect(workflow).toContain("pnpm submission:verify:external");
    expect(workflow).toContain("pnpm test:docker:platformclaw-runtime");
  });

  it("never presents the internal final gate as a hosted-runner proof", () => {
    expect(workflow).toContain("github.event_name == 'workflow_dispatch'");
    expect(workflow).toContain("inputs.run_internal_final");
    expect(workflow).toContain("refs/heads/submission/hello-ai-2026-final");
    expect(workflow).toContain("runs-on: [self-hosted, linux, platformclaw-internal]");
    expect(workflow).toContain("environment: platformclaw-internal-final");
    expect(workflow).toContain("pnpm submission:verify:final");
  });

  it("requires every actual result, business metric, video, and screenshot surface", () => {
    for (const evidence of [
      "build-result.json",
      "board-lease-result.json",
      "board-validation-result.json",
      "report-result.json",
      "knox-result.json",
      "verification-result.json",
      "business-metrics.json",
      "video-metadata.json",
      "screenshots",
    ]) {
      expect(finalGate).toContain(evidence);
    }
    expect(finalGate).toContain('merge-base", "--is-ancestor"');
    expect(finalGate).toContain('mode !== "actual"');
  });
});
