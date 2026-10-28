import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { registerSkillHubRunPolicy } from "./run-policy.js";

const event = {
  candidates: [
    {
      name: "sheet",
      filePath: "/sandbox/skills/sheet-2/SKILL.md",
      sourceFilePath: "/workspace/skills/sheet/SKILL.md",
    },
  ],
};

function fixture(response: { status: number; body: Record<string, unknown> }) {
  const on = vi.fn<OpenClawPluginApi["on"]>();
  const roomSkills = vi.fn(async () => response);
  registerSkillHubRunPolicy({ on }, { roomSkills, request: vi.fn() });
  expect(on.mock.calls[0]?.[0]).toBe("before_skill_context");
  const handler = on.mock.calls[0]![1] as (
    skillEvent: typeof event,
    context: { agentId: string; sessionKey: string },
  ) => Promise<{ excludedPaths: string[] }>;
  return {
    roomSkills,
    run: () => handler(event, { agentId: "group-room", sessionKey: "agent:group-room:main" }),
  };
}

describe("SkillHub managed room skill policy", () => {
  it.each([{ excludedPaths: [] }, { excludedPaths: [event.candidates[0]!.filePath] }])(
    "returns only the owner service's exact candidate exclusions %j",
    async ({ excludedPaths }) => {
      const f = fixture({ status: 200, body: { excludedPaths } });
      await expect(f.run()).resolves.toEqual({ excludedPaths });
      expect(f.roomSkills).toHaveBeenCalledWith({
        agentId: "group-room",
        candidates: event.candidates,
      });
    },
  );

  it.each([
    { status: 503, body: {} },
    { status: 200, body: { excludedPaths: ["/another/workspace/SKILL.md"] } },
    { status: 200, body: { excludedPaths: [1] } },
  ])("fails visibly when the authority response cannot be trusted %j", async (response) => {
    await expect(fixture(response).run()).rejects.toThrow(/permission/i);
  });

  it("does not turn a transport failure into permission to use a cached copy", async () => {
    const f = fixture({ status: 200, body: { excludedPaths: [] } });
    f.roomSkills.mockRejectedValueOnce(new Error("connection closed"));
    await expect(f.run()).rejects.toThrow("permissions could not be verified");
  });

  it("forwards managed source exclusions independently of discoverable candidates", async () => {
    const excludedSourceDirectories = ["/workspace/skills/private"];
    await expect(
      fixture({ status: 200, body: { excludedPaths: [], excludedSourceDirectories } }).run(),
    ).resolves.toEqual({ excludedPaths: [], excludedSourceDirectories });
  });
});
