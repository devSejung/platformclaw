import { describe, expect, it } from "vitest";
import {
  buildAgentHarnessQuestionPromptPayload,
  buildAgentHarnessUserInputAnswers,
  type AgentHarnessUserInputQuestion,
} from "./user-input-bridge.js";

const question: AgentHarnessUserInputQuestion = {
  id: "colors",
  header: "Colors",
  question: "Which colors?",
  multiSelect: true,
  options: [{ label: "Red" }, { label: "Blue" }, { label: "Green, yellow" }],
};

describe("harness plain-text multiple selections", () => {
  it.each(["1, 2", "Red, blue", "1\nBlue", "1, Red, 2, BLUE"])(
    "maps and deduplicates %j into option values",
    (text) => {
      expect(buildAgentHarnessUserInputAnswers([question], text)).toEqual({
        answers: { colors: { answers: ["Red", "Blue"] } },
      });
    },
  );

  it.each(["1, 9", "Red, unknown", "1,", "0", ""])(
    "rejects invalid fixed selections without accepting a subset: %j",
    (text) => {
      expect(buildAgentHarnessUserInputAnswers([question], text).answers.colors?.answers).toEqual(
        [],
      );
    },
  );

  it("preserves exact labels containing commas and separate custom answers", () => {
    expect(
      buildAgentHarnessUserInputAnswers([question], "Green, yellow").answers.colors?.answers,
    ).toEqual(["Green, yellow"]);
    const other = { ...question, isOther: true };
    expect(
      buildAgentHarnessUserInputAnswers([other], "Purple, orange").answers.colors?.answers,
    ).toEqual(["Purple, orange"]);
    expect(buildAgentHarnessUserInputAnswers([other], "1, 9").answers.colors?.answers).toEqual([]);
  });

  it("keeps single-choice behavior and maps keyed multi-question replies", () => {
    const single = { ...question, id: "primary", multiSelect: false };
    expect(buildAgentHarnessUserInputAnswers([single], "1, 2").answers.primary?.answers).toEqual(
      [],
    );
    expect(
      buildAgentHarnessUserInputAnswers([question, single], "colors: 1, 2\nprimary: 3"),
    ).toEqual({
      answers: {
        colors: { answers: ["Red", "Blue"] },
        primary: { answers: ["Green, yellow"] },
      },
    });
  });

  it("advertises the answer format without atomic single-choice controls", () => {
    const payload = buildAgentHarnessQuestionPromptPayload({
      questionId: "ask_colors",
      questions: [question],
    });
    expect(payload.text).toContain("commas or newlines (for example, 1, 2)");
    expect(payload.presentation).toBeUndefined();
    expect(payload.channelData.askUser.optionValues).toBeUndefined();
  });
});
