import assert from "node:assert/strict";
import test from "node:test";
import * as examples from "../src/demo-content.ts";
import { englishCopy, motionText, resolveMotionLocale } from "../src/i18n.ts";
import { topics } from "../src/topics.ts";

test("both locales cover all example data and all eight topic descriptions", () => {
  const check = (value) => {
    if (typeof value === "string" && /[가-힣]/u.test(value)) {
      assert.ok(Object.hasOwn(englishCopy, value), "Missing English copy: " + value);
      assert.equal(motionText(value, "ko"), value);
      assert.doesNotMatch(motionText(value, "en"), /[가-힣]/u);
    } else if (value && typeof value === "object") {
      Object.values(value).forEach(check);
    }
  };
  check(examples);
  check(topics);
  for (const [source, english] of Object.entries(englishCopy)) {
    assert.ok(english.trim(), "Empty translation: " + source);
    assert.doesNotMatch(english, /[가-힣]/u);
  }
  for (const shared of [
    "Ulysses",
    "Jira",
    "ULY-142",
    "JIRA_API_TOKEN",
    ...examples.terminalCommands,
  ]) {
    assert.equal(motionText(shared, "ko"), shared);
    assert.equal(motionText(shared, "en"), shared);
  }
});

test("Player locale resolves Korean variants and English fallback without extra timelines", () => {
  for (const value of [undefined, null, "", "ko", "ko-KR"])
    assert.equal(resolveMotionLocale(value), "ko");
  for (const value of ["en", "en-US", "fr", "ja-JP"])
    assert.equal(resolveMotionLocale(value), "en");
  assert.equal(topics.length, 8);
});
