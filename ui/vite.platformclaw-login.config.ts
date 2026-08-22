import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin, UserConfig } from "vite";
import { createControlUiPrecompressedAssetVariants } from "./vite.config.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, "../dist/control-ui");

function platformclawPrecompressedAssetsPlugin(buildOutDir: string): Plugin {
  return {
    name: "platformclaw-precompressed-assets",
    apply: "build",
    writeBundle(_options, bundle) {
      // This second Vite build appends the login bundle after the main UI build.
      // Finalize its sidecars here so the shared package/performance gates see it.
      for (const output of Object.values(bundle)) {
        const source = fs.readFileSync(path.join(buildOutDir, output.fileName));
        for (const variant of createControlUiPrecompressedAssetVariants(output.fileName, source)) {
          fs.writeFileSync(path.join(buildOutDir, variant.fileName), variant.source);
        }
      }
    },
  };
}

export default function platformclawLoginViteConfig(options: { outDir?: string } = {}): UserConfig {
  const buildOutDir = options.outDir ?? outDir;
  return {
    base: "./",
    publicDir: false,
    plugins: [platformclawPrecompressedAssetsPlugin(buildOutDir)],
    build: {
      outDir: buildOutDir,
      emptyOutDir: false,
      sourcemap: true,
      rolldownOptions: {
        input: path.resolve(here, "platformclaw-login.html"),
      },
    },
  };
}
