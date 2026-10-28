// Vitest UI package config tests validate UI package test project settings.
import path from "node:path";
import { describe, expect, it } from "vitest";
import uiConfig from "../ui/vitest.config.ts";
import uiNodeConfig from "../ui/vitest.node.config.ts";
import { createUiIsolatedVitestConfig } from "./vitest/vitest.ui-isolated.config.ts";
import { createUiVitestConfig } from "./vitest/vitest.ui.config.ts";

type ExpectedTestConfig = {
  isolate?: boolean;
  include?: string[];
  exclude?: string[];
  name?: string;
  pool?: string;
  projects?: unknown[];
  runner?: string;
};

function requireTestConfig(config: unknown): ExpectedTestConfig {
  if (!config || typeof config !== "object" || !("test" in config) || !config.test) {
    throw new Error("expected ui package vitest test config");
  }
  return config.test as ExpectedTestConfig;
}

describe("ui package vitest config", () => {
  it.each([
    "ui/src/app/native-gateways.test.ts",
    "ui/src/build-info.test.ts",
    "ui/src/components/modal-dialog.test.ts",
    "ui/src/pages/plugins/view.test.ts",
  ])("isolates module-resetting %s from sibling DOM registries in both UI runners", (file) => {
    const shared = requireTestConfig(createUiVitestConfig({}));
    const isolated = requireTestConfig(createUiIsolatedVitestConfig({}));
    expect(shared.exclude).toContain(file);
    expect(isolated.include).toContain(file);
    expect(isolated.isolate).toBe(true);

    const packageFile = file.slice("ui/".length);
    const owners = (requireTestConfig(uiConfig).projects ?? [])
      .map(requireTestConfig)
      .filter(
        (project) =>
          project.include?.some((pattern) => path.matchesGlob(packageFile, pattern)) &&
          !project.exclude?.some((pattern) => path.matchesGlob(packageFile, pattern)),
      );
    expect(owners.map((owner) => owner.name)).toEqual(["unit-mock-registry"]);
    expect(owners[0]?.isolate).toBe(true);
  });

  it("keeps the standalone ui package on thread workers without broad isolation", () => {
    const testConfig = requireTestConfig(uiConfig);

    expect(testConfig.pool).toBe("threads");
    expect(testConfig.isolate).toBe(false);
    expect(testConfig.projects).toHaveLength(4);

    for (const project of testConfig.projects ?? []) {
      const projectTestConfig = requireTestConfig(project);
      expect(projectTestConfig.pool).toBe("threads");
      expect(projectTestConfig.isolate).toBe(projectTestConfig.name === "unit-mock-registry");
      expect(projectTestConfig.runner).toBeUndefined();
    }
  });

  it("keeps the standalone ui node config on thread workers without isolation", () => {
    const testConfig = requireTestConfig(uiNodeConfig);

    expect(testConfig.pool).toBe("threads");
    expect(testConfig.isolate).toBe(false);
    expect(testConfig.runner).toBeUndefined();
  });
});
