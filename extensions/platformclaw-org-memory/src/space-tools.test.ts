import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import type { WikiHubMemoryClient } from "./client.js";
import { registerSpaceTools } from "./space-tools.js";
describe("Space recall tools", () => {
  it("pins the trusted runtime actor/run and advertises only read operations", async () => {
    const registerTool = vi.fn();
    const resolveAdmissionId = vi.fn((context: { runId?: string }) =>
      context.runId === "run-a" ? "admission-a" : context.runId,
    );
    const spaceRead = vi.fn(async () => ({ results: [] }));
    registerSpaceTools(
      {
        registerTool,
        runContext: { resolveAdmissionId },
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
      runId: "admission-a",
      operation: "search",
      query: "timing",
    });
    expect(resolveAdmissionId).toHaveBeenCalledWith({ agentId: "person-a", runId: "run-a" });
    expect(search.parameters).toEqual({
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 1000 },
        spaceId: { type: "string", maxLength: 128 },
      },
      required: ["query"],
      additionalProperties: false,
    });
    const get = registerTool.mock.calls[1]![0]({ agentId: "person-a", runId: "run-a" });
    expect(get.parameters).toEqual({
      type: "object",
      properties: {
        spaceId: { type: "string", maxLength: 128 },
        pageId: { type: "string", maxLength: 128 },
        messageId: { type: "string", maxLength: 256 },
        bodyOffset: { type: "integer", minimum: 0, maximum: 32000 },
        pageRevision: { type: "integer", minimum: 1 },
      },
      required: ["spaceId", "pageId"],
      additionalProperties: false,
    });
    await get.execute("page-window", {
      spaceId: "space-a",
      pageId: "page-a",
      bodyOffset: 8000,
      pageRevision: 3,
    });
    expect(spaceRead).toHaveBeenLastCalledWith({
      agentId: "person-a",
      runId: "admission-a",
      operation: "get",
      spaceId: "space-a",
      pageId: "page-a",
      bodyOffset: 8000,
      pageRevision: 3,
    });
    expect(search.parameters.properties.agentId).toBeUndefined();
    expect(search.parameters.properties.runId).toBeUndefined();
    expect(registerTool.mock.calls.map((call) => call[1].name)).toEqual([
      "space_search",
      "space_get",
    ]);
  });
});
