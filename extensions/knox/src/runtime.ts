import { createPluginRuntimeStore, type PluginRuntime } from "openclaw/plugin-sdk/runtime-store";

const { setRuntime: setKnoxRuntime, getRuntime: getKnoxRuntime } =
  createPluginRuntimeStore<PluginRuntime>({
    pluginId: "knox",
    errorMessage: "Knox runtime not initialized - plugin not registered",
  });

export { getKnoxRuntime, setKnoxRuntime };
