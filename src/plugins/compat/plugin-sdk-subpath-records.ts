import type { PluginCompatRecord } from "./types.js";

type SeedFields = "code" | "owner" | "removeAfter" | "replacement";
type PluginSdkSubpathSeed = Pick<PluginCompatRecord, SeedFields> &
  Record<"subpath", string> &
  Partial<Pick<PluginCompatRecord, "status">>;

const PLATFORMCLAW_UPSTREAM_SYNC_REVIEW_AFTER = "2026-09-30";

const PLUGIN_SDK_SUBPATH_SEEDS = [
  {
    code: "plugin-sdk-channel-streaming-subpath",
    subpath: "channel-streaming",
    status: "removal-pending",
    owner: "channel",
    removeAfter: PLATFORMCLAW_UPSTREAM_SYNC_REVIEW_AFTER,
    replacement: "`openclaw/plugin-sdk/channel-outbound`",
  },
  {
    code: "plugin-sdk-config-runtime-subpath",
    subpath: "config-runtime",
    status: "removed",
    owner: "config",
    removeAfter: "2026-09-30",
    replacement:
      "`api.pluginConfig`, injected `api.runtime.config` snapshot/write capabilities, and typed `openclaw/plugin-sdk/config-contracts`; official plugins may also use private JavaScript-only config-mutation and runtime-config-snapshot host surfaces",
  },
  {
    code: "plugin-sdk-inbound-reply-dispatch-subpath",
    subpath: "inbound-reply-dispatch",
    status: "removal-pending",
    owner: "channel",
    removeAfter: PLATFORMCLAW_UPSTREAM_SYNC_REVIEW_AFTER,
    replacement: "`openclaw/plugin-sdk/channel-inbound` and `openclaw/plugin-sdk/channel-outbound`",
  },
  {
    code: "plugin-sdk-channel-reply-pipeline-subpath",
    subpath: "channel-reply-pipeline",
    status: "removed",
    owner: "channel",
    removeAfter: "2026-09-30",
    replacement: "`openclaw/plugin-sdk/channel-outbound`",
  },
  {
    code: "plugin-sdk-infra-runtime-subpath",
    subpath: "infra-runtime",
    status: "removed",
    owner: "sdk",
    removeAfter: "2026-09-30",
    replacement:
      "focused typed public contracts such as diagnostic-runtime, error-runtime, ssrf-runtime, and system-event-runtime, or injected runtime capabilities; official plugins may additionally use private JavaScript-only delivery-queue-runtime, exec-approvals-runtime, and fetch-runtime host surfaces",
  },
  {
    code: "plugin-sdk-text-runtime-subpath",
    subpath: "text-runtime",
    status: "removal-pending",
    owner: "sdk",
    removeAfter: PLATFORMCLAW_UPSTREAM_SYNC_REVIEW_AFTER,
    replacement:
      "`openclaw/plugin-sdk/logging-core`, `openclaw/plugin-sdk/text-chunking`, `openclaw/plugin-sdk/text-utility-runtime`, and `openclaw/plugin-sdk/string-coerce-runtime`",
  },
  {
    code: "plugin-sdk-channel-secret-runtime-subpath",
    subpath: "channel-secret-runtime",
    status: "removal-pending",
    owner: "channel",
    removeAfter: PLATFORMCLAW_UPSTREAM_SYNC_REVIEW_AFTER,
    replacement:
      "`openclaw/plugin-sdk/channel-secret-basic-runtime` and `openclaw/plugin-sdk/channel-secret-tts-runtime`",
  },
  {
    code: "plugin-sdk-agent-config-primitives-subpath",
    subpath: "agent-config-primitives",
    status: "removal-pending",
    owner: "config",
    removeAfter: PLATFORMCLAW_UPSTREAM_SYNC_REVIEW_AFTER,
    replacement: "`openclaw/plugin-sdk/channel-config-schema`",
  },
  {
    code: "plugin-sdk-matrix-subpath",
    subpath: "matrix",
    status: "removal-pending",
    owner: "channel",
    removeAfter: PLATFORMCLAW_UPSTREAM_SYNC_REVIEW_AFTER,
    replacement: "`openclaw/plugin-sdk/run-command`",
  },
  {
    code: "plugin-sdk-channel-logging-subpath",
    subpath: "channel-logging",
    status: "removal-pending",
    owner: "channel",
    removeAfter: PLATFORMCLAW_UPSTREAM_SYNC_REVIEW_AFTER,
    replacement: "`openclaw/plugin-sdk/channel-inbound` and `openclaw/plugin-sdk/channel-outbound`",
  },
  {
    code: "plugin-sdk-channel-lifecycle-subpath",
    subpath: "channel-lifecycle",
    status: "removed",
    owner: "channel",
    removeAfter: "2026-09-30",
    replacement: "`openclaw/plugin-sdk/channel-outbound`",
  },
  {
    code: "plugin-sdk-channel-message-subpath",
    subpath: "channel-message",
    status: "removed",
    owner: "channel",
    removeAfter: "2026-09-30",
    replacement: "`openclaw/plugin-sdk/channel-outbound` and `openclaw/plugin-sdk/channel-inbound`",
  },
  {
    code: "plugin-sdk-group-access-subpath",
    subpath: "group-access",
    status: "removal-pending",
    owner: "channel",
    removeAfter: PLATFORMCLAW_UPSTREAM_SYNC_REVIEW_AFTER,
    replacement: "`openclaw/plugin-sdk/channel-ingress-runtime`",
  },
  {
    code: "plugin-sdk-zod-subpath",
    subpath: "zod",
    status: "removal-pending",
    owner: "sdk",
    removeAfter: PLATFORMCLAW_UPSTREAM_SYNC_REVIEW_AFTER,
    replacement: "the direct `zod` package import",
  },
] as const satisfies readonly PluginSdkSubpathSeed[];

export const DEPRECATED_PLUGIN_SDK_SUBPATH_RECORDS = PLUGIN_SDK_SUBPATH_SEEDS.map((seed) => {
  const { code, subpath, owner, removeAfter, replacement } = seed;
  const status = "status" in seed ? seed.status : "deprecated";
  return {
    code,
    status,
    owner,
    introduced: "2026-07-06",
    deprecated: "2026-07-06",
    warningStarts: "2026-07-06",
    removeAfter,
    replacement:
      status === "removal-pending"
        ? `${replacement}; PlatformClaw removal remains blocked until a verified upstream sync adopts the owning migration`
        : replacement,
    docsPath: "/plugins/sdk-migration",
    surfaces: [`openclaw/plugin-sdk/${subpath}`],
    diagnostics: [
      "repository deprecated API usage guard for core and bundled plugins; no external runtime import warning",
    ],
    tests: ["src/plugins/compat/registry.test.ts"],
    releaseNote:
      status === "removed"
        ? "Removed under the SDK-owner September 30 breaking-release decision in upstream e649be315d75; plugin authors must use the focused replacement subpaths."
        : undefined,
  } satisfies PluginCompatRecord;
}) satisfies readonly PluginCompatRecord[];

const BUNDLED_ONLY_PUBLIC_PLUGIN_SDK_SUBPATH_SEEDS = [
  {
    subpath: "media-understanding",
    status: "removal-pending",
    removeAfter: "2026-09-30",
    replacement:
      "`api.registerMediaUnderstandingProvider(...)` with provider-owned request helpers and types from `openclaw/plugin-sdk/plugin-entry`; retain the public subpath through the 2026-09-30 window while official plugin consumers migrate",
    docsPath: "/plugins/architecture",
  },
  {
    subpath: "memory-host-core",
    status: "removal-pending",
    removeAfter: "2026-09-30",
    replacement:
      "host-prepared memory prompts via `openclaw/plugin-sdk/core` and memory capability registration through the injected plugin API; retain the facade through the 2026-09-30 window and until a focused public-artifact read seam exists",
    docsPath: "/plugins/architecture-internals#context-engine-plugins",
  },
  {
    subpath: "plugin-config-runtime",
    status: "removal-pending",
    removeAfter: "2026-12-01",
    replacement:
      "`api.pluginConfig`, runtime tool context config, and focused `config-contracts`, `runtime-config-snapshot`, or `config-mutation` subpaths; retain the public subpath through the 2026-12-01 window while official plugin consumers migrate",
    docsPath: "/plugins/sdk-runtime",
  },
  {
    subpath: "tool-plugin",
    status: "deprecated",
    replacement:
      "retain the public subpath until plugin authoring has a nonexecuting static metadata replacement for `defineToolPlugin`; `getToolPluginMetadata` currently reads metadata only from an already-executed entry",
    docsPath: "/plugins/tool-plugins",
  },
] as const;

function buildPublicSdkSubpathRecord({
  subpath,
  ...compat
}: (typeof BUNDLED_ONLY_PUBLIC_PLUGIN_SDK_SUBPATH_SEEDS)[number]) {
  return {
    code: `plugin-sdk-${subpath}-public-demotion` as const,
    owner: "sdk" as const,
    introduced: "2026-07-15",
    deprecated: "2026-07-15",
    warningStarts: "2026-07-15",
    ...compat,
    surfaces: [`openclaw/plugin-sdk/${subpath}`],
    diagnostics: ["registry-backed public SDK demotion window; no external runtime import warning"],
    tests: ["src/plugins/compat/registry.test.ts"],
  } satisfies PluginCompatRecord;
}

export const BUNDLED_ONLY_PUBLIC_PLUGIN_SDK_SUBPATH_RECORDS =
  BUNDLED_ONLY_PUBLIC_PLUGIN_SDK_SUBPATH_SEEDS.map(buildPublicSdkSubpathRecord);
