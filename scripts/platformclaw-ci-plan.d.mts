export type PlatformClawChangeMode = "none" | "docs" | "platformclaw" | "upstream";

export type PlatformClawChangePlan = {
  files: string[];
  mode: PlatformClawChangeMode;
  needs_dependencies: boolean;
  needs_policy_guards: boolean;
  needs_docs_checks: boolean;
  needs_format_check: boolean;
  needs_overlay_lint: boolean;
  needs_package_checks: boolean;
  needs_planner_tests: boolean;
  needs_workflow_checks: boolean;
  needs_ui_checks: boolean;
  needs_deployment_checks: boolean;
  needs_changed_surface_checks: boolean;
};

export function classifyPlatformClawChanges(inputFiles: string[]): PlatformClawChangePlan;
export function parseGitNameStatus(output: string): string[];
