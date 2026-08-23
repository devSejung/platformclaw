import { describe, expect, it } from "vitest";
import {
  extractScriptTargetFromCommand,
  hasLiteralCdInterpreterChain,
} from "./bash-tools.exec-script-target.js";

describe("extractScriptTargetFromCommand", () => {
  it.each([
    ["python", "script.py", "python"],
    ["python3", "script.py", "python"],
    ["node", "script.js", "node"],
  ] as const)("accepts a literal cd followed by %s", (interpreter, script, kind) => {
    expect(extractScriptTargetFromCommand(`cd "literal dir" && ${interpreter} ${script}`)).toEqual({
      kind,
      relOrAbsPaths: [script],
      cwd: "literal dir",
    });
  });

  it.each([
    ["variable cd", 'cd "$SCRIPT_DIR" && node script.js'],
    ["substituted cd", 'cd "$(pwd)" && node script.js'],
    ["variable script", 'cd literal-dir && node "$SCRIPT"'],
    ["substituted script", 'cd literal-dir && node "$(printf script.js)"'],
    ["redirect", "cd literal-dir && node script.js > output.txt"],
    ["pipeline", "cd literal-dir && node script.js | cat"],
    ["extra chain", "cd literal-dir && node script.js && echo done"],
    ["script arguments", "cd literal-dir && node script.js --unsafe"],
    ["env wrapper", "cd literal-dir && env node script.js"],
    ["previous-directory operand", "cd - && node script.js"],
    ["option-like operand", "cd -P && node script.js"],
    ["option terminator without directory", "cd -- && node script.js"],
  ])("rejects a %s chain", (_name, command) => {
    expect(extractScriptTargetFromCommand(command)).toBeNull();
  });

  it("leaves unrelated shell chains to the ambiguity guard", () => {
    expect(extractScriptTargetFromCommand("true && node script.js")).toBeNull();
  });

  it.each([
    ["variable", 'cd literal-dir && node "$SCRIPT"'],
    ["substitution", 'cd literal-dir && node "$(printf script.js)"'],
  ])("identifies a literal cd chain with a %s script target", (_name, command) => {
    expect(hasLiteralCdInterpreterChain(command)).toBe(true);
  });
});
