// @vitest-environment node
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build, normalizePath } from "vite";
import { describe, expect, it } from "vitest";
import { controlUiPdfAssetsPlugin } from "../../config/control-ui-pdf-assets.ts";

const require = createRequire(import.meta.url);

describe("local PDF.js assets", () => {
  it("emits all resources and resolves directory URLs in a real relative build", async () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "control-ui-pdf-assets-")));
    try {
      const entry = path.join(root, "entry.mjs");
      const outDir = path.join(root, "dist");
      writeFileSync(entry, 'export { pdfAssetUrls } from "virtual:openclaw-pdf-assets";\n');
      const result = await build({
        root,
        configFile: false,
        base: "./",
        logLevel: "silent",
        plugins: [controlUiPdfAssetsPlugin()],
        build: {
          outDir,
          minify: false,
          rolldownOptions: {
            input: entry,
            preserveEntrySignatures: "strict",
            output: { entryFileNames: "assets/preview.mjs" },
          },
        },
      });
      const bundle = Array.isArray(result) ? result[0] : result;
      if (!bundle || !("output" in bundle)) {
        throw new Error("Expected a completed PDF asset build");
      }
      const packageFile = require.resolve("pdfjs-dist/package.json");
      const packageRoot = path.dirname(packageFile);
      const metadata: unknown = JSON.parse(readFileSync(packageFile, "utf8"));
      if (!metadata || typeof metadata !== "object" || !("version" in metadata)) {
        throw new Error("Expected PDF.js package metadata");
      }
      expect(metadata.version).toBe("6.4.299");
      const prefix = "assets/pdfjs-6.4.299";
      expect(readFileSync(path.join(outDir, prefix, "LICENSE"))).toEqual(
        readFileSync(path.join(packageRoot, "LICENSE")),
      );
      const expectedFiles = [`${prefix}/LICENSE`];
      const expectedUrls: Record<string, string> = {};
      for (const [property, directory] of Object.entries({
        cMapUrl: "cmaps",
        standardFontDataUrl: "standard_fonts",
        wasmUrl: "wasm",
        iccUrl: "iccs",
      })) {
        const sourceRoot = path.join(packageRoot, directory);
        const outputRoot = path.join(outDir, prefix, directory);
        expectedUrls[property] = pathToFileURL(`${outputRoot}${path.sep}`).href;
        const files = readdirSync(sourceRoot, { recursive: true, withFileTypes: true });
        expect(files.some((file) => file.name.startsWith("LICENSE"))).toBe(true);
        for (const file of files) {
          if (!file.isFile()) {
            continue;
          }
          const source = path.join(file.parentPath, file.name);
          const relative = path.relative(sourceRoot, source);
          const output = path.join(outputRoot, relative);
          expect(readFileSync(output)).toEqual(readFileSync(source));
          expectedFiles.push(`${prefix}/${directory}/${normalizePath(relative)}`);
        }
      }
      expect(
        bundle.output
          .filter((output) => output.type === "asset")
          .map((output) => output.fileName)
          .toSorted(),
      ).toEqual(expectedFiles.toSorted());
      // A native import preserves import.meta.url instead of Vitest rewriting it.
      const exported = execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `const {pdfAssetUrls} = await import(process.argv[1]);
process.stdout.write(JSON.stringify(pdfAssetUrls));`,
          pathToFileURL(path.join(outDir, "assets/preview.mjs")).href,
        ],
        { encoding: "utf8" },
      );
      expect(JSON.parse(exported)).toEqual(expectedUrls);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
