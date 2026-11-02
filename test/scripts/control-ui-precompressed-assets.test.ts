import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

const temporaryRoots: string[] = [];

function createAssetFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "control-ui-sidecars-"));
  temporaryRoots.push(root);
  fs.mkdirSync(path.join(root, ".git"));
  fs.mkdirSync(path.join(root, "scripts/lib"), { recursive: true });
  for (const file of ["check-control-ui-precompressed-assets.mjs", "lib/repo-root.mjs"]) {
    fs.copyFileSync(path.resolve("scripts", file), path.join(root, "scripts", file));
  }
  const assets = path.join(root, "dist/control-ui/assets");
  fs.mkdirSync(path.join(assets, "workers"), { recursive: true });
  fs.mkdirSync(path.join(assets, "pdfjs/fonts"), { recursive: true });
  for (const file of ["index.js", "workers/document.js", "pdfjs/fonts/LICENSE.txt"]) {
    const source = Buffer.from(`Final emitted bytes for ${file}`);
    fs.writeFileSync(path.join(assets, file), source);
    fs.writeFileSync(path.join(assets, `${file}.gz`), gzipSync(source));
    fs.writeFileSync(path.join(assets, `${file}.br`), brotliCompressSync(source));
  }
  const run = () =>
    spawnSync(
      process.execPath,
      [path.join(root, "scripts/check-control-ui-precompressed-assets.mjs")],
      { cwd: root, encoding: "utf8" },
    );
  return { assets, run };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("finalized Control UI sidecar verification", () => {
  it("verifies both encodings for ordinary, worker, and nested PDF resources", () => {
    const fixture = createAssetFixture();
    const result = fixture.run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("verified 6 finalized Control UI sidecars");
  });

  it.each(["workers/document.js", "pdfjs/fonts/LICENSE.txt"])(
    "rejects a stale nested sidecar for %s through the actual CLI",
    (file) => {
      const fixture = createAssetFixture();
      fs.writeFileSync(path.join(fixture.assets, file), "Changed after compression");
      const result = fixture.run();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("decoded bytes differ");
      expect(result.stderr).toContain(path.normalize(file));
    },
  );
});
