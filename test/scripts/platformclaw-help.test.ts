import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import * as examples from "../../tools/platformclaw-help/src/demo-content.js";
import {
  englishCopy,
  motionText,
  resolveMotionLocale,
} from "../../tools/platformclaw-help/src/i18n.js";
import { sceneAt, topics } from "../../tools/platformclaw-help/src/topics.js";
import { typedPrefix } from "../../tools/platformclaw-help/src/typing.js";

const root = path.resolve(import.meta.dirname, "../../tools/platformclaw-help");

it("keeps the canonical PlatformClaw brand without a nested product runtime", async () => {
  const manifest = JSON.parse(
    await fs.readFile(path.join(root, "src/product-brand.generated.json"), "utf8"),
  );
  const mascot = await fs.readFile(path.join(root, "public/brand/platformclaw-mascot.svg"));
  expect(createHash("sha256").update(mascot).digest("hex")).toBe(
    manifest.sources["ui/src/platformclaw/platformclaw-pixel.svg"],
  );
  expect(mascot.toString()).toMatch(/PlatformClaw arcade pixel crab/);
  expect(manifest.tokens["--accent"]).toBe("#0f7c72");
  expect(manifest.architecture).toBe("native-remotion-fragments");
  const clip = await fs.readFile(path.join(root, "src/HelpClip.tsx"), "utf8");
  expect(clip).not.toMatch(/<iframe|postMessage|scene\.caption/);
  const build = JSON.parse(
    await fs.readFile(path.resolve(root, "../../ui/public/help-video/build-manifest.json"), "utf8"),
  );
  expect(build.productRuntimeBundled).toBe(false);
  for (const file of Object.keys(build.outputs).filter((name) => name.endsWith(".js"))) {
    const text = await fs.readFile(path.resolve(root, "../../ui/public/help-video", file), "utf8");
    expect(text, "legacy product runtime or brand leaked into " + file).not.toMatch(
      /OpenClaw|openclaw|capture-seek/,
    );
    expect(text, "superseded generic example in " + file).not.toMatch(/주간|회의|weekly-summary/);
  }
});

it("keeps eight timelines bounded and deterministic when seeking", () => {
  expect(topics).toHaveLength(8);
  expect(new Set(topics.map((topic) => topic.id)).size).toBe(8);
  for (const topic of topics) {
    expect(topic.scenes[0].at).toBe(0);
    for (const scene of topic.scenes) {
      expect(scene.at).toBeLessThan(topic.seconds);
      expect(sceneAt(topic, scene.at * 30).scene).toBe(scene);
      expect(sceneAt(topic, topic.seconds * 30 - 1).scene).toBe(topic.scenes.at(-1));
      expect(sceneAt(topic, scene.at * 30).scene).toBe(scene);
    }
  }
});

it("covers all example data and all eight descriptions in both locales", () => {
  const check = (value: unknown): void => {
    if (typeof value === "string" && /[가-힣]/u.test(value)) {
      expect(Object.hasOwn(englishCopy, value), "Missing English copy: " + value).toBe(true);
      expect(motionText(value, "ko")).toBe(value);
      expect(motionText(value, "en")).not.toMatch(/[가-힣]/u);
    } else if (value && typeof value === "object") {
      Object.values(value).forEach(check);
    }
  };
  check(examples);
  check(topics);
  for (const [source, english] of Object.entries(englishCopy)) {
    expect(english.trim(), "Empty translation: " + source).not.toBe("");
    expect(english).not.toMatch(/[가-힣]/u);
  }
  for (const shared of [
    "Ulysses",
    "Jira",
    "ULY-142",
    "JIRA_API_TOKEN",
    ...examples.terminalCommands,
  ]) {
    expect(motionText(shared, "ko")).toBe(shared);
    expect(motionText(shared, "en")).toBe(shared);
  }
});

it("resolves Korean variants and English fallback without extra timelines", () => {
  for (const value of [undefined, null, "", "ko", "ko-KR"]) {
    expect(resolveMotionLocale(value)).toBe("ko");
  }
  for (const value of ["en", "en-US", "fr", "ja-JP"]) {
    expect(resolveMotionLocale(value)).toBe("en");
  }
  expect(topics).toHaveLength(8);
});

it("finishes prompts, terminal commands and masked values without a late character stall", () => {
  for (const [text, from, to] of [
    [examples.chatExample.prompt, 54, 87],
    [motionText(examples.chatExample.prompt, "en"), 54, 87],
    [examples.terminalCommands[0], 237, 285],
    [examples.terminalCommands[1], 297, 351],
    ["••••••••••••", 147, 195],
  ] as const) {
    expect(typedPrefix(text, from, from, to)).toBe("");
    let previousLength = 0;
    const changeFrames: number[] = [from];
    for (let frame = from + 1; frame <= to; frame++) {
      const visible = typedPrefix(text, frame, from, to);
      expect(text.startsWith(visible)).toBe(true);
      const count = Array.from(visible).length;
      if (count !== previousLength) {
        changeFrames.push(frame);
      }
      previousLength = count;
    }
    const longestInterval = Math.ceil((to - from) / Array.from(text).length);
    expect(changeFrames).toHaveLength(Array.from(text).length + 1);
    let previousFrame: number = from;
    for (const changeFrame of changeFrames.slice(1)) {
      expect(changeFrame - previousFrame).toBeLessThanOrEqual(longestInterval);
      previousFrame = changeFrame;
    }
    expect(typedPrefix(text, to, from, to)).toBe(text);
    expect(typedPrefix(text, to + 15, from, to)).toBe(text);
  }
});
