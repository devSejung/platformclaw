import { afterEach, describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import { createMockPluginRegistry } from "./hooks.test-helpers.js";

afterEach(() => vi.useRealTimers());
const event = {
  candidates: [
    { name: "one", filePath: "/skills/one/SKILL.md" },
    { name: "two", filePath: "/skills/two/SKILL.md" },
  ],
};

describe("before_skill_context", () => {
  it("unions exclusions without letting a later plugin widen the selected set", async () => {
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_skill_context",
          handler: () => ({ excludedPaths: [event.candidates[0]!.filePath] }),
        },
        { hookName: "before_skill_context", handler: () => ({ excludedPaths: [] }) },
        {
          hookName: "before_skill_context",
          handler: () => ({ excludedPaths: [event.candidates[1]!.filePath] }),
        },
      ]),
    );
    await expect(runner.runBeforeSkillContext(event, {})).resolves.toEqual({
      excludedPaths: event.candidates.map((candidate) => candidate.filePath),
    });
  });

  it.each([null, { excludedPaths: ["/another/skill/SKILL.md"] }, { excludedPaths: [1] }])(
    "fails closed on invalid exclusions %j",
    async (result) => {
      const runner = createHookRunner(
        createMockPluginRegistry([{ hookName: "before_skill_context", handler: () => result }]),
      );
      await expect(runner.runBeforeSkillContext(event, {})).rejects.toThrow(
        "invalid candidate exclusions",
      );
    },
  );

  it("fails closed when a required check does not finish", async () => {
    vi.useFakeTimers();
    const runner = createHookRunner(
      createMockPluginRegistry([
        { hookName: "before_skill_context", handler: () => new Promise<never>(() => {}) },
      ]),
    );
    const result = runner.runBeforeSkillContext(event, {});
    const rejected = expect(result).rejects.toThrow("timed out after 15000ms");
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
  });

  it("retains managed directory exclusions even when no skill candidate is discoverable", async () => {
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_skill_context",
          handler: () => ({
            excludedPaths: [],
            excludedSourceDirectories: ["/workspace/skills/private"],
          }),
        },
      ]),
    );
    await expect(runner.runBeforeSkillContext({ candidates: [] }, {})).resolves.toEqual({
      excludedPaths: [],
      excludedSourceDirectories: ["/workspace/skills/private"],
    });
  });

  it.each([
    "relative/path",
    "/workspace/skills/../private",
    "/workspace/skills/./private",
    "bad\0path",
    1,
  ])("rejects invalid source directory authority %j", async (directory) => {
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_skill_context",
          handler: () => ({ excludedPaths: [], excludedSourceDirectories: [directory] }),
        },
      ]),
    );
    await expect(runner.runBeforeSkillContext({ candidates: [] }, {})).rejects.toThrow(
      "invalid source directory exclusions",
    );
  });
});
