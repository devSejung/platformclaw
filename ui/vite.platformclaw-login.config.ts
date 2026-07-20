import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: "./",
  publicDir: false,
  build: {
    outDir: path.resolve(here, "../dist/control-ui"),
    emptyOutDir: false,
    sourcemap: true,
    rolldownOptions: {
      input: path.resolve(here, "platformclaw-login.html"),
    },
  },
});
