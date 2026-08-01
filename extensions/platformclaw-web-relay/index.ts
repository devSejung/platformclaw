import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  createPlatformClawRelayWebFetchProvider,
  createPlatformClawRelayWebSearchProvider,
} from "./src/providers.js";

export default definePluginEntry({
  id: "platformclaw-web-relay",
  name: "PlatformClaw Web Relay",
  description: "Routes web_fetch and web_search through operator-configured relay endpoints.",
  register(api) {
    api.registerWebFetchProvider(createPlatformClawRelayWebFetchProvider());
    api.registerWebSearchProvider(createPlatformClawRelayWebSearchProvider());
  },
});
