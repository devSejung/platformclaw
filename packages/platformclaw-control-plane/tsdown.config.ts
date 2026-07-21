import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/server-main.ts"],
  platform: "node",
  format: "esm",
  dts: true,
  outDir: "dist",
  clean: true,
  // The private runtime copies this package without the source workspace.
  // Bundle OpenClaw workspace dependencies; keep normal npm dependencies external.
  deps: {
    alwaysBundle: [/^@openclaw\//u],
    onlyBundle: false,
    dts: { neverBundle: [/^@openclaw\//u] },
  },
});
