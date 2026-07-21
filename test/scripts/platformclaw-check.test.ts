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
