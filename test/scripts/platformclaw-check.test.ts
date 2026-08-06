import { describe, expect, it } from "vitest";
import {
  createPlatformClawCheckCommands,
  findPatchWhitespaceErrors,
  surfacesForPlan,
} from "../../scripts/platformclaw-check.mjs";
import { classifyPlatformClawChanges } from "../../scripts/platformclaw-ci-plan.mjs";

describe("PlatformClaw shared checks", () => {
  it("runs lint, production and test types, and tests for Admin HTTP RPC", () => {
    const commands = createPlatformClawCheckCommands(["admin-http-rpc"]);

    expect(commands.map((entry) => entry.label)).toEqual([
      "lint admin HTTP RPC",
      "typecheck admin HTTP RPC",
      "typecheck admin HTTP RPC tests",
      "test admin HTTP RPC",
    ]);
    expect(commands[1]?.args).toContain("extensions/admin-http-rpc/tsconfig.platformclaw.json");
    expect(commands[2]?.args).toContain(
      "extensions/admin-http-rpc/tsconfig.platformclaw.test.json",
    );
  });

  it("keeps typechecks and tests in quick mode while skipping builds", () => {
    const commands = createPlatformClawCheckCommands(["control-plane", "ui"], { quick: true });
    const labels = commands.map((entry) => entry.label);

    expect(labels).toContain("typecheck control plane");
    expect(labels).toContain("test control plane");
    expect(labels).toContain("typecheck UI");
    expect(labels).not.toContain("build control plane");
    expect(labels).not.toContain("build UI");
  });

  it("selects focused surfaces from the change plan", () => {
    const plan = classifyPlatformClawChanges([
      "extensions/admin-http-rpc/index.ts",
      "packages/platformclaw-control-plane/src/index.ts",
    ]);

    expect(surfacesForPlan(plan)).toEqual(["control-plane", "admin-http-rpc"]);
  });

  it("selects Knox channel checks", () => {
    const plan = classifyPlatformClawChanges(["extensions/knox/src/gateway.ts"]);

    expect(surfacesForPlan(plan)).toEqual(["knox"]);
    expect(createPlatformClawCheckCommands(["knox"]).map((entry) => entry.label)).toEqual([
      "lint Knox channel",
      "typecheck Knox channel",
      "test Knox channel",
    ]);
  });

  it("selects execution, user MCP, Board Farm, and skill policy checks", () => {
    const plan = classifyPlatformClawChanges([
      "extensions/platformclaw-execution/src/remote-skills.ts",
      "extensions/platformclaw-user-mcp/src/runtime.ts",
      "packages/platformclaw-control-plane/src/board-farm/runtime.ts",
    ]);

    expect(surfacesForPlan(plan)).toEqual([
      "control-plane",
      "platformclaw-execution",
      "platformclaw-user-mcp",
      "board-farm",
      "skill-policy",
    ]);
  });

  it("selects submission document and evidence checks", () => {
    const plan = classifyPlatformClawChanges([
      "docs/submission/README.md",
      "submission/evaluation-map.yaml",
    ]);

    expect(surfacesForPlan(plan)).toEqual(["submission-docs", "submission-evidence"]);
    expect(
      createPlatformClawCheckCommands(["submission-docs", "submission-evidence"]).map(
        (entry) => entry.label,
      ),
    ).toEqual([
      "check submission document consistency",
      "check submission blindness",
      "check offline submission slides",
      "check submission evaluation map",
      "check submission internal requirements",
    ]);
  });

  it("rejects unknown check surfaces", () => {
    expect(() => createPlatformClawCheckCommands(["unknown"])).toThrow(
      "unknown PlatformClaw check surface",
    );
  });

  it("finds whitespace errors in untracked text files", () => {
    expect(findPatchWhitespaceErrors("clean\ntrailing \n<<<<<<< ours\n")).toEqual([
      { line: 2, reason: "trailing whitespace" },
      { line: 3, reason: "conflict marker" },
    ]);
  });
});
