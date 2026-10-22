import { isBuiltin } from "node:module";
import type { Plugin } from "vite";

export function nativeNodeTestBuiltinsPlugin(): Plugin {
  return {
    name: "openclaw-native-node-test-builtins",
    enforce: "pre",
    resolveId(id) {
      // Node-driven jsdom suites still load the native runner and server fixtures.
      // Vite 8's browser stub drops builtin IDs that Vitest needs for native imports.
      if (isBuiltin(id)) {
        return { id, external: true };
      }
      return null;
    },
  };
}
