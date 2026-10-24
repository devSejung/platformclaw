import {
  toCodexDynamicToolProgressResponse,
  toCodexDynamicToolProtocolResponse,
} from "./dynamic-tool-execution.js";
import {
  withDynamicToolTranscriptDetails,
  type CodexDynamicToolRuntimeResponse,
} from "./dynamic-tool-response-state.js";
import { recordCodexDynamicToolResult } from "./dynamic-tool-result-projection.js";
import {
  buildEmptyToolTelemetry,
  createProjector,
  describe,
  expect,
  it,
  registerCodexEventProjectorTestLifecycle,
} from "./event-projector.test-harness.js";

registerCodexEventProjectorTestLifecycle();

const uiAction = {
  version: 1,
  kind: "settings",
  feature: "sample.credentials",
  requestId: "d745f81c-6421-4d72-8b68-baf4c3f04e11",
  targetKey: "REPORT_API_TOKEN",
};

function responseWithDetails(details: unknown): CodexDynamicToolRuntimeResponse {
  return withDynamicToolTranscriptDetails(
    {
      contentItems: [{ type: "inputText", text: "Use the secure registration form." }],
      success: true,
    },
    details,
  );
}

describe("Codex host-owned dynamic tool details", () => {
  it("preserves settings actions through host progress and mirrored results without sending them to Codex", async () => {
    const response = responseWithDetails({
      uiAction,
      structuredContent: { privateModelPayload: "synthetic-private-value" },
    });
    const protocol = toCodexDynamicToolProtocolResponse(response);
    expect(protocol).toEqual({ contentItems: response.contentItems, success: true });
    expect(response.transcriptDetails).toEqual({ uiAction });
    expect(Object.keys(response)).not.toContain("transcriptDetails");
    expect(JSON.stringify(response)).not.toContain("uiAction");
    expect(JSON.stringify(response)).not.toContain("synthetic-private-value");
    expect(toCodexDynamicToolProgressResponse(response, protocol)).toEqual({
      ...protocol,
      details: { uiAction },
    });

    const projector = await createProjector();
    const call = {
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-register-key",
      namespace: null,
      tool: "sample_credentials",
      arguments: { action: "request", envName: "REPORT_API_TOKEN" },
    };
    projector.recordDynamicToolCall(call);
    recordCodexDynamicToolResult(projector, call, response, protocol);
    const result = projector.buildResult(buildEmptyToolTelemetry());
    const toolResult = result.messagesSnapshot.find((message) => message.role === "toolResult");
    expect(toolResult).toMatchObject({
      role: "toolResult",
      toolCallId: call.callId,
      details: { uiAction },
    });
    expect(JSON.stringify(result.messagesSnapshot)).not.toContain("synthetic-private-value");
  });

  it("keeps the MCP App preview alongside a settings action in host progress only", () => {
    const mcpAppPreview = {
      kind: "canvas",
      view: { id: "mcp-app-view-1" },
      presentation: { target: "assistant_message", sandbox: "scripts" },
      mcpApp: { viewId: "mcp-app-view-1" },
    };
    const response = responseWithDetails({ uiAction, mcpAppPreview, structuredContent: {} });
    const protocol = toCodexDynamicToolProtocolResponse(response);
    expect(response.transcriptDetails).toEqual({ uiAction, mcpAppPreview });
    expect(toCodexDynamicToolProgressResponse(response, protocol).details).toEqual({
      uiAction,
      mcpAppPreview,
    });
    expect(JSON.stringify(protocol)).not.toContain("uiAction");
    expect(JSON.stringify(protocol)).not.toContain("mcpAppPreview");
    expect(JSON.stringify(response)).not.toContain("transcriptDetails");
  });

  it.each([undefined, null, "settings", 42, [], [uiAction]])(
    "ignores a non-record settings action: %j",
    (action) => {
      const response = responseWithDetails({ uiAction: action });
      expect(response.transcriptDetails).toBeUndefined();
      const protocol = toCodexDynamicToolProtocolResponse(response);
      expect(toCodexDynamicToolProgressResponse(response, protocol)).toEqual(protocol);
    },
  );
});
