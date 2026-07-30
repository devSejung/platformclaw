import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  id: "knox",
  name: "Knox Teams",
  description: "Samsung Knox Teams relay channel for PlatformClaw",
  importMetaUrl: import.meta.url,
  plugin: { specifier: "./channel-plugin-api.js", exportName: "knoxPlugin" },
  runtime: { specifier: "./api.js", exportName: "setKnoxRuntime" },
});
