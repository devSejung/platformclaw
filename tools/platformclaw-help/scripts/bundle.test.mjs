import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
const root = path.resolve(import.meta.dirname, "..");
test("canonical PlatformClaw brand, without upstream fallback or nested UI runtime", async () => {
  const manifest = JSON.parse(
    await fs.readFile(path.join(root, "src/product-brand.generated.json"), "utf8"),
  );
  const mascot = await fs.readFile(path.join(root, "public/brand/platformclaw-mascot.svg"));
  assert.equal(
    createHash("sha256").update(mascot).digest("hex"),
    manifest.sources["ui/src/platformclaw/platformclaw-pixel.svg"],
  );
  assert.match(mascot.toString(), /PlatformClaw arcade pixel crab/);
  assert.equal(manifest.tokens["--accent"], "#0f7c72");
  assert.equal(manifest.architecture, "native-remotion-fragments");
  const clip = await fs.readFile(path.join(root, "src/HelpClip.tsx"), "utf8");
  assert.doesNotMatch(clip, /<iframe|postMessage|scene\.caption/);
  const build = JSON.parse(
    await fs.readFile(path.resolve(root, "../../ui/public/help-video/build-manifest.json"), "utf8"),
  );
  assert.equal(build.productRuntimeBundled, false);
  for (const file of Object.keys(build.outputs).filter((f) => f.endsWith(".js"))) {
    const text = await fs.readFile(path.resolve(root, "../../ui/public/help-video", file), "utf8");
    assert.doesNotMatch(
      text,
      /OpenClaw|openclaw|capture-seek/,
      "legacy product runtime or brand leaked into " + file,
    );
    assert.doesNotMatch(text, /주간|회의|weekly-summary/, "superseded generic example in " + file);
  }
});
test("8 motion timelines have bounded scenes and deterministic seek boundaries", async () => {
  const { topics, sceneAt } = await import("../src/topics.ts");
  assert.equal(topics.length, 8);
  assert.equal(new Set(topics.map((t) => t.id)).size, 8);
  for (const topic of topics) {
    assert.equal(topic.scenes[0].at, 0);
    for (const scene of topic.scenes) {
      assert.ok(scene.at < topic.seconds);
      assert.equal(sceneAt(topic, scene.at * 30).scene, scene);
      sceneAt(topic, topic.seconds * 30 - 1);
      assert.equal(sceneAt(topic, scene.at * 30).scene, scene);
    }
  }
});
