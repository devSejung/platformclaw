import type { PlatformClawChangePlan } from "./platformclaw-ci-plan.mjs";

export type PlatformClawCheckSurface =
  | "admin-http-rpc"
  | "control-plane"
  | "knox"
  | "platformclaw-execution"
  | "platformclaw-user-mcp"
  | "board-farm"
  | "skill-policy"
  | "planner"
  | "submission-docs"
  | "submission-evidence"
  | "ui";

export type PlatformClawCheckCommand = {
  label: string;
  executable: string;
  args: string[];
};

export function createPlatformClawCheckCommands(
  surfaces: string[],
  options?: { quick?: boolean },
): PlatformClawCheckCommand[];

export function surfacesForPlan(plan: PlatformClawChangePlan): PlatformClawCheckSurface[];

export function findPatchWhitespaceErrors(
  text: string,
): Array<{ line: number; reason: "conflict marker" | "trailing whitespace" }>;
