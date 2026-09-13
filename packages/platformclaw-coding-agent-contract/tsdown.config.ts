import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  platform: "neutral",
  format: "esm",
  dts: true,
  outDir: "dist",
  outExtensions: () => ({ js: ".mjs", dts: ".d.mts" }),
  clean: true,
  // The final private image copies this package without the source workspace.
  deps: {
    alwaysBundle: [/^@openclaw\//u],
    onlyBundle: false,
    dts: { neverBundle: [/^@openclaw\//u] },
  },
});
