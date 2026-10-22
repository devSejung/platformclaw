import { describe, expect, it } from "vitest";
import { describeIncompleteTurnFailure } from "./incomplete-turn-diagnostics.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

describe("incomplete-turn failure diagnostics", () => {
  it.each([
    ["toolUse", [], "unfinished_tools"],
    ["length", [], "output_limit"],
    ["error", [], "service_error"],
    ["stop", [], "empty_response"],
    ["stop", [{ type: "thinking", thinking: "private reasoning" }], "reasoning_only"],
  ] as const)(
    "describes %s without exposing private provider content",
    (stopReason, content, reason) => {
      const failure = describeIncompleteTurnFailure(
        {
          lastAssistant: undefined,
          currentAttemptAssistant: {
            role: "assistant",
            stopReason,
            content,
            errorMessage: "private-provider-detail",
          } as unknown as EmbeddedRunAttemptResult["currentAttemptAssistant"],
        },
        false,
      );
      expect(failure.reason).toBe(reason);
      expect(failure.message).not.toMatch(/private|EPIPE|openclaw logs/);
      expect(failure.message.length).toBeGreaterThan(20);
    },
  );

  it("uses the current attempt instead of stale session output", () => {
    expect(
      describeIncompleteTurnFailure(
        {
          currentAttemptAssistant: { role: "assistant", stopReason: "length", content: [] },
          lastAssistant: { role: "assistant", stopReason: "error", content: [] },
        } as unknown as Parameters<typeof describeIncompleteTurnFailure>[0],
        false,
      ).reason,
    ).toBe("output_limit");
    expect(describeIncompleteTurnFailure({ lastAssistant: undefined }, false).reason).toBe(
      "missing_assistant",
    );
    expect(describeIncompleteTurnFailure({ lastAssistant: undefined }, true).reason).toBe(
      "interrupted",
    );
  });
});
