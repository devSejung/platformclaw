import { access } from "node:fs/promises";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveCanvasDocumentsDir } from "./documents.js";
import { createShowWidgetTool } from "./widget-tool.js";

describe("widget presentation capabilities", () => {
  it("offers only inline inputs when the current surface cannot present dashboards", () => {
    const tool = createShowWidgetTool();
    expect(tool.parameters).toMatchObject({ required: ["title", "widget_code"] });
    for (const field of ["title", "widget_code", "widget_path"]) {
      expect(tool.parameters).toHaveProperty(`properties.${field}`);
    }
    for (const field of ["pin", "name", "tab", "size", "presentation", "after", "capabilities"]) {
      expect(tool.parameters).not.toHaveProperty(`properties.${field}`);
    }
    expect(tool.description).not.toContain("pin=true");
    expect(tool.description).not.toContain("openclaw.data.read");
  });

  it("rejects unsupported dashboard inputs before any document or board write", async () => {
    const state = await createOpenClawTestState({ prefix: "widget-inline-capability-" });
    onTestFinished(() => state.cleanup());
    const callGateway = vi.fn(async () => {
      throw new Error("Unexpected dashboard write");
    });
    const tool = createShowWidgetTool({
      stateDir: state.stateDir,
      sessionId: "inline",
      agentSessionKey: "agent:main:inline",
      callGateway,
    });
    for (const input of [
      { pin: true },
      { pin: false },
      { name: "chart" },
      { tab: "main" },
      { size: "lg" },
      { presentation: "frameless" },
      { after: "existing" },
      { capabilities: { tools: ["prompt"] } },
    ]) {
      await expect(
        tool.execute("unsupported-dashboard", {
          title: "Chart",
          widget_code: "<p>Inline chart</p>",
          ...input,
        }),
      ).rejects.toThrow("Dashboard widgets are unavailable on this surface");
    }
    expect(callGateway).not.toHaveBeenCalled();
    await expect(access(resolveCanvasDocumentsDir(state.stateDir))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("still materializes an inline follow-up picker without dashboard support", async () => {
    const state = await createOpenClawTestState({ prefix: "widget-inline-picker-" });
    onTestFinished(() => state.cleanup());
    const tool = createShowWidgetTool({ stateDir: state.stateDir, sessionId: "inline-picker" });
    const result = await tool.execute("picker", {
      title: "Choose a detail",
      widget_code: "<button onclick=\"sendPrompt('Inspect the selected item')\">Inspect ↗</button>",
    });
    expect(result.details).toMatchObject({
      kind: "canvas",
      presentation: { target: "assistant_message", sandbox: "scripts" },
    });
    expect(result.details).toHaveProperty("view.url");
    expect(result.details).not.toHaveProperty("view.boardWidgetName");
  });

  it.each([false, true])(
    "rejects broken scripts at their original location before publishing (dashboard: %s)",
    async (supportsDashboard) => {
      const state = await createOpenClawTestState({ prefix: "widget-script-admission-" });
      onTestFinished(() => state.cleanup());
      const callGateway = vi.fn(async () => {
        throw new Error("Unexpected dashboard write");
      });
      const tool = createShowWidgetTool({
        supportsDashboard,
        stateDir: state.stateDir,
        sessionId: "invalid-script",
        agentSessionKey: "agent:main:invalid-script",
        callGateway,
      });
      const result = tool.execute("invalid-script", {
        title: "Broken selection",
        widget_code: "\n\n  <script>\n    const answer = ;\n  </script>\n",
        ...(supportsDashboard ? { pin: true } : {}),
      });
      await expect(result).rejects.toThrow(
        "inline script 1 at line 4, column 19: Unexpected token",
      );
      await expect(result).rejects.toThrow(
        "Offending line: const answer = ;. Fix the script and call show_widget again.",
      );
      expect(callGateway).not.toHaveBeenCalled();
      await expect(access(resolveCanvasDocumentsDir(state.stateDir))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );
});
