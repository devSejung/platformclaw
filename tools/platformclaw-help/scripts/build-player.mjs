import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
const root = path.resolve(import.meta.dirname, "..");
const target = path.resolve(root, "../../ui/public/help-video");
await fs.mkdir(target, { recursive: true });
const result = await build({
  entryPoints: {
    player: path.join(root, "src/player.tsx"),
    gallery: path.join(root, "src/gallery.tsx"),
  },
  outdir: target,
  entryNames: "[name]",
  chunkNames: "chunks/[name]-[hash]",
  bundle: true,
  splitting: true,
  format: "esm",
  minify: true,
  // Escape dependency CSS strings so generated files contain no trailing whitespace.
  supported: { "template-literal": false },
  metafile: true,
  define: { "process.env.NODE_ENV": '"production"' },
});
const generated = new Set(Object.keys(result.metafile.outputs).map((file) => path.resolve(file)));
const chunkDirectory = path.join(target, "chunks");
for (const name of await fs.readdir(chunkDirectory)) {
  const file = path.resolve(chunkDirectory, name);
  if (/^chunk-[A-Z0-9]+\.js$/.test(name) && !generated.has(file)) await fs.unlink(file);
}
await fs.cp(path.join(root, "public/brand"), path.join(target, "brand"), {
  recursive: true,
});
const html = (entry, mount, title) =>
  `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><link rel="icon" type="image/svg+xml" href="./brand/platformclaw-mascot.svg"><link rel="stylesheet" href="./${entry}.css"><style>html,body{margin:0}#player{width:100%}</style></head><body><div id="${mount}"></div><script type="module" src="./${entry}.js"></script></body></html>`;
await fs.writeFile(
  path.join(target, "player.html"),
  html("player", "player", "PlatformClaw motion"),
);
await fs.writeFile(
  path.join(target, "index.html"),
  html("gallery", "gallery", "PlatformClaw 모션 가이드"),
);
// oxfmt 0.60 stabilizes some bundled member chains on its second pass.
// Require the normal gate after both passes so unstable output fails the build.
const formatter = path.resolve(root, "../../node_modules/oxfmt/bin/oxfmt");
for (let pass = 0; pass < 2; pass++) {
  execFileSync(process.execPath, [formatter, target], { stdio: "inherit" });
}
execFileSync(process.execPath, [formatter, "--check", target], { stdio: "inherit" });
const sourceFiles = [
  ...(await fs.readdir(path.join(root, "src"))).map((file) => `src/${file}`),
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "scripts/build-player.mjs",
  "scripts/extract-brand.mjs",
  "public/brand/platformclaw-mascot.svg",
  "public/brand/manifest.json",
].sort();
const outputFiles = [
  ...Object.keys(result.metafile.outputs).map((file) =>
    path.relative(target, path.resolve(file)).replaceAll("\\", "/"),
  ),
  "player.html",
  "index.html",
  "brand/platformclaw-mascot.svg",
  "brand/manifest.json",
].sort();
// Normalize text line endings so Windows checkouts validate the same source.
const digestFiles = async (directory, files) =>
  Object.fromEntries(
    await Promise.all(
      files.map(async (file) => [
        file,
        createHash("sha256")
          .update((await fs.readFile(path.join(directory, file), "utf8")).replaceAll("\r\n", "\n"))
          .digest("hex"),
      ]),
    ),
  );
await fs.writeFile(
  path.join(target, "build-manifest.json"),
  JSON.stringify(
    {
      architecture: "native-remotion-fragments",
      outputs: Object.fromEntries(
        await Promise.all(
          Object.keys(result.metafile.outputs).map(async (file) => [
            path.relative(target, path.resolve(file)).replaceAll("\\", "/"),
            (await fs.stat(path.resolve(file))).size,
          ]),
        ),
      ),
      productRuntimeBundled: false,
      sourceSha256: await digestFiles(root, sourceFiles),
      outputSha256: await digestFiles(target, outputFiles),
    },
    null,
    2,
  ),
);
console.log(
  "Native Remotion motion films and gallery built. Full product runtime: none. No video output.",
);
