// Control UI config module wires vitest behavior.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { resolveDefaultVitestPool } from "../test/vitest/vitest.shared.config.ts";
import { controlUiLocaleModulesPlugin } from "./config/control-ui-locales.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

// Node-only tests for pure logic (no Playwright/browser dependency).
export default defineConfig({
  plugins: [controlUiLocaleModulesPlugin()],
  resolve: {
    alias: [
      {
        find: "@platformclaw/coding-agent-contract",
        replacement: path.resolve(
          repoRoot,
          "packages/platformclaw-coding-agent-contract/src/index.ts",
        ),
      },
    ],
  },
  test: {
    isolate: false,
    pool: resolveDefaultVitestPool(),
    testTimeout: 120_000,
    include: [
      "src/**/*.node.test.ts",
      "src/pages/chat/chat-responsive.browser.test.ts",
      "src/pages/sessions/view.browser.test.ts",
    ],
    environment: "node",
  },
});
