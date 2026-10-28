// Vitest ui-isolated config preserves the dedicated UI project partition.
// Both UI projects use native per-file DOM and module isolation.
import { controlUiLocaleModulesPlugin } from "../../ui/config/control-ui-locales.ts";
import { nativeNodeTestBuiltinsPlugin } from "./vitest.native-node-builtins.ts";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";
import { jsdomOptimizedDeps } from "./vitest.shared.config.ts";
import { uiIsolatedTestFiles } from "./vitest.ui-isolated-paths.mjs";

export function createUiIsolatedVitestConfig(env?: Record<string, string | undefined>) {
  const config = createScopedVitestConfig(uiIsolatedTestFiles, {
    deps: jsdomOptimizedDeps,
    environment: "jsdom",
    env,
    excludeUnitFastTests: false,
    includeOpenClawRuntimeSetup: false,
    isolate: true,
    name: "ui-isolated",
    setupFiles: ["ui/src/test-helpers/lit-warnings.setup.ts"],
    useNonIsolatedRunner: false,
  });
  return {
    ...config,
    plugins: [
      nativeNodeTestBuiltinsPlugin(),
      ...(config.plugins ?? []),
      controlUiLocaleModulesPlugin(),
    ],
  };
}

export default createUiIsolatedVitestConfig();
