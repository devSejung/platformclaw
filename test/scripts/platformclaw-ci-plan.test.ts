import { describe, expect, it } from "vitest";
// @ts-expect-error The dependency-free CI entrypoint intentionally remains plain ESM.
import {
  classifyPlatformClawChanges,
  parseGitNameStatus,
} from "../../scripts/platformclaw-ci-plan.mjs";

describe("classifyPlatformClawChanges", () => {
  it("keeps private documentation changes on focused checks", () => {
    const plan = classifyPlatformClawChanges(["docs/platformclaw/architecture.md"]);

    expect(plan.mode).toBe("docs");
    expect(plan.needs_docs_checks).toBe(true);
    expect(plan.needs_dependencies).toBe(true);
    expect(plan.needs_format_check).toBe(true);
    expect(plan.needs_changed_surface_checks).toBe(false);
  });

  it("runs focused control-plane checks without upstream fanout", () => {
    const plan = classifyPlatformClawChanges([
      "packages/platformclaw-control-plane/src/browser-auth-http.ts",
    ]);

    expect(plan.mode).toBe("platformclaw");
    expect(plan.needs_package_checks).toBe(true);
    expect(plan.needs_overlay_lint).toBe(true);
    expect(plan.needs_changed_surface_checks).toBe(false);
  });

  it("validates workflow and planner changes", () => {
    const plan = classifyPlatformClawChanges([
      ".github/workflows/platformclaw-ci.yml",
      "scripts/platformclaw-ci-plan.mjs",
    ]);

    expect(plan.needs_workflow_checks).toBe(true);
    expect(plan.needs_planner_tests).toBe(true);
    expect(plan.needs_dependencies).toBe(true);
  });

  it("recognizes deployment and future private UI surfaces", () => {
    const plan = classifyPlatformClawChanges([
      "docker/platformclaw-jammy/Dockerfile",
      "ui/src/platformclaw/login.ts",
    ]);

    expect(plan.needs_deployment_checks).toBe(true);
    expect(plan.needs_ui_checks).toBe(true);
    expect(plan.needs_dependencies).toBe(true);
    expect(plan.needs_changed_surface_checks).toBe(false);
  });

  it("falls back to upstream checks for core changes", () => {
    const plan = classifyPlatformClawChanges(["src/gateway/server.ts"]);

    expect(plan.mode).toBe("upstream");
    expect(plan.needs_changed_surface_checks).toBe(true);
  });

  it("keeps focused and upstream checks for mixed changes", () => {
    const plan = classifyPlatformClawChanges([
      "packages/platformclaw-control-plane/src/index.ts",
      "src/gateway/server.ts",
    ]);

    expect(plan.needs_package_checks).toBe(true);
    expect(plan.needs_format_check).toBe(true);
    expect(plan.needs_changed_surface_checks).toBe(true);
  });

  it("normalizes Windows separators and duplicate paths", () => {
    const plan = classifyPlatformClawChanges([
      "packages\\platformclaw-control-plane\\src\\index.ts",
      "packages/platformclaw-control-plane/src/index.ts",
    ]);

    expect(plan.files).toEqual(["packages/platformclaw-control-plane/src/index.ts"]);
  });
});

describe("parseGitNameStatus", () => {
  it("keeps both sides of renames and copies", () => {
    expect(
      parseGitNameStatus(
        "M\0docs/platformclaw/ci.md\0R100\0src/gateway.ts\0scripts/platformclaw-gateway.mjs\0C75\0src/a.ts\0src/b.ts\0",
      ),
    ).toEqual([
      "docs/platformclaw/ci.md",
      "src/gateway.ts",
      "scripts/platformclaw-gateway.mjs",
      "src/a.ts",
      "src/b.ts",
    ]);
  });

  it("rejects truncated rename records", () => {
    expect(() => parseGitNameStatus("R100\0src/gateway.ts\0")).toThrow(
      "Missing destination path for R100",
    );
  });
});
