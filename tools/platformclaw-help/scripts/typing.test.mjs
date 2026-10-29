import assert from "node:assert/strict";
import test from "node:test";
import { chatExample, terminalCommands } from "../src/demo-content.ts";
import { motionText } from "../src/i18n.ts";
import { typedPrefix } from "../src/typing.ts";

test("all typed prompts, terminal commands, and masked values finish without a late character stall", () => {
  for (const [text, from, to] of [
    [chatExample.prompt, 54, 87],
    [motionText(chatExample.prompt, "en"), 54, 87],
    [terminalCommands[0], 237, 285],
    [terminalCommands[1], 297, 351],
    ["••••••••••••", 147, 195],
  ]) {
    assert.equal(typedPrefix(text, from, from, to), "");
    let previousLength = 0;
    const changeFrames = [from];
    for (let frame = from + 1; frame <= to; frame++) {
      const visible = typedPrefix(text, frame, from, to);
      assert.ok(text.startsWith(visible));
      const count = Array.from(visible).length;
      if (count !== previousLength) changeFrames.push(frame);
      previousLength = count;
    }
    const longestInterval = Math.ceil((to - from) / Array.from(text).length);
    assert.equal(changeFrames.length, Array.from(text).length + 1);
    for (let i = 1; i < changeFrames.length; i++) {
      assert.ok(changeFrames[i] - changeFrames[i - 1] <= longestInterval);
    }
    assert.equal(typedPrefix(text, to, from, to), text);
    assert.equal(typedPrefix(text, to + 15, from, to), text);
  }
});
