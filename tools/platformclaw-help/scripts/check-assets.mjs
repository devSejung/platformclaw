import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const target = path.resolve(root, "../../ui/public/help-video");
try {
  const manifest = JSON.parse(await fs.readFile(path.join(target, "build-manifest.json"), "utf8"));
  const sources = [
    ...(await fs.readdir(path.join(root, "src"))).map((file) => `src/${file}`),
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.json",
    "scripts/build-player.mjs",
    "scripts/extract-brand.mjs",
    "public/brand/platformclaw-mascot.svg",
    "public/brand/manifest.json",
  ].toSorted((left, right) => left.localeCompare(right));
  assert.deepEqual(
    Object.keys(manifest.sourceSha256).toSorted((left, right) => left.localeCompare(right)),
    sources,
    "Motion source inventory changed; rebuild the help assets",
  );
  for (const file of [
    "build/player.js",
    "build/player.css",
    "build/gallery.js",
    "build/gallery.css",
  ]) {
    assert.ok(Object.hasOwn(manifest.outputs, file), `Missing help entry: ${file}`);
  }
  assert.deepEqual(
    Object.keys(manifest.outputSha256).toSorted((left, right) => left.localeCompare(right)),
    [
      ...Object.keys(manifest.outputs),
      "player.html",
      "index.html",
      "brand/platformclaw-mascot.svg",
      "brand/manifest.json",
    ].toSorted((left, right) => left.localeCompare(right)),
    "Help output inventory changed",
  );
  for (const [directory, hashes] of [
    [root, manifest.sourceSha256],
    [target, manifest.outputSha256],
  ]) {
    for (const [file, expected] of Object.entries(hashes)) {
      assert.ok(
        !path.isAbsolute(file) && !file.split(/[\\/]/u).some((part) => part === ".."),
        "Invalid manifest path",
      );
      const actual = createHash("sha256")
        .update((await fs.readFile(path.join(directory, file), "utf8")).replaceAll("\r\n", "\n"))
        .digest("hex");
      assert.equal(actual, expected, `Stale help asset: ${file}; rebuild tools/platformclaw-help`);
    }
  }
  const files = [];
  const collect = async (directory, prefix = "") => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (entry.isDirectory()) {
        await collect(path.join(directory, entry.name), relative + "/");
      } else {
        files.push(relative);
      }
    }
  };
  await collect(target);
  assert.deepEqual(
    files.toSorted((left, right) => left.localeCompare(right)),
    [...Object.keys(manifest.outputSha256), "build-manifest.json"].toSorted((left, right) =>
      left.localeCompare(right),
    ),
    "Unexpected files in generated help assets",
  );
  console.log("Help motion sources and browser assets match; no obsolete chunks.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error("[help-assets] FAILED (exit 1)");
  process.exitCode = 1;
}
