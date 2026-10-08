import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readSessionToolVisibilityRestrictions,
  withSessionToolVisibilityRestrictions,
} from "../plugin-sdk/session-visibility.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-fixtures.js";
import {
  createToolSearchCatalogRef,
  registerHeadlessToolSearchCatalog,
  resolveToolSearchConfig,
  ToolSearchRuntime,
} from "./tool-search.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";
import { createSessionsListTool } from "./tools/sessions-list-tool.js";
import { createSessionsSearchTool } from "./tools/sessions-search-tool.js";

afterEach(() => {
  resetGlobalHookRunner();
});

describe("session visibility policy through Tool Search", () => {
  it.each(["sessions_list", "sessions_search"] as const)(
    "preserves restrictions through the native %s schema and execution wrapper",
    async (name) => {
      const restrictions = {
        denyKeyPatterns: ["agent:space-*-*-*-*-*:space:*"],
        denyKeySubstrings: [":space-session:"],
      };
      const hook = vi.fn(async (event: unknown) => {
        const { params } = event as { params: Record<string, unknown> };
        return { params: withSessionToolVisibilityRestrictions(params, restrictions) };
      });
      initializeGlobalHookRunner(
        createMockPluginRegistry([{ hookName: "before_tool_call", handler: hook }]),
      );
      const nativeTool =
        name === "sessions_list"
          ? createSessionsListTool({ config: {} })
          : createSessionsSearchTool({ config: {} });
      const execute = vi.fn<AnyAgentTool["execute"]>(async () =>
        jsonResult(name === "sessions_list" ? { count: 0, sessions: [] } : { results: [] }),
      );
      const catalogRef = createToolSearchCatalogRef();
      registerHeadlessToolSearchCatalog({
        catalogRef,
        tools: [{ ...nativeTool, execute }],
        hookContext: { agentId: "main", sessionKey: "agent:main:main" },
      });
      const runtime = new ToolSearchRuntime(
        { catalogRef },
        resolveToolSearchConfig({ tools: { toolSearch: { enabled: true, mode: "tools" } } }),
        { validateInput: true },
      );
      const input = name === "sessions_list" ? { limit: 1 } : { query: "trace", limit: 1 };

      await runtime.call(name, input);

      expect(hook).toHaveBeenCalledOnce();
      expect(execute).toHaveBeenCalledOnce();
      const forwarded = execute.mock.calls[0]?.[1];
      expect(forwarded).toMatchObject(input);
      expect(readSessionToolVisibilityRestrictions(forwarded as Record<string, unknown>)).toEqual(
        restrictions,
      );

      await expect(runtime.call(name, { ...input, limit: "invalid" })).rejects.toThrow("limit");
      expect(execute).toHaveBeenCalledOnce();
    },
  );
});
