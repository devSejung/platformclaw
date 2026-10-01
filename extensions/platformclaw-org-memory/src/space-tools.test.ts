import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import type { WikiHubMemoryClient } from "./client.js";
import { registerSpaceTools } from "./space-tools.js";
describe("Space recall tools", () => {
  it("pins the trusted runtime actor/run and advertises only read operations", async () => {
    const registerTool = vi.fn();
    const spaceRead = vi.fn(async () => ({ results: [] }));
    registerSpaceTools(
      {
        registerTool,
        on: vi.fn(),
        registerMemoryPromptSupplement: vi.fn(),
      } as unknown as OpenClawPluginApi,
      { spaceRead } as unknown as WikiHubMemoryClient,
    );
    const search = registerTool.mock.calls[0]![0]({ agentId: "person-a", runId: "run-a" });
    await search.execute("call", {
      query: "timing",
      agentId: "forged-agent",
      operation: "context",
      runId: "forged-run",
    });
    expect(spaceRead).toHaveBeenCalledWith({
      agentId: "person-a",
      runId: "run-a",
      operation: "search",
      query: "timing",
    });
    expect(search.parameters.properties.agentId).toBeUndefined();
    expect(search.parameters.properties.runId).toBeUndefined();
    expect(registerTool.mock.calls.map((call) => call[1].name)).toEqual([
      "space_search",
      "space_get",
    ]);
  });
});
