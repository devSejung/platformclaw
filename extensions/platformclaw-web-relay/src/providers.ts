import {
  DEFAULT_TIMEOUT_SECONDS,
  markdownToText,
  readResponseText,
  resolveTimeoutSeconds,
  truncateText,
  withTrustedWebToolsEndpoint,
  type WebFetchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-fetch";
import {
  buildSearchCacheKey,
  readCachedSearchPayload,
  resolveSearchCacheTtlMs,
  resolveSearchTimeoutSeconds,
  withTrustedWebSearchEndpoint,
  writeCachedSearchPayload,
} from "openclaw/plugin-sdk/provider-web-search";
import {
  createWebSearchProviderContractFields,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search-contract";
import { resolvePinnedHostnameWithPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import { extractBasicHtmlContent } from "openclaw/plugin-sdk/web-content-extractor";
import { Type } from "typebox";

const PROVIDER_ID = "platformclaw-relay";
const FETCH_RELAY_URL_ENV = "WEB_FETCH_RELAY_URL";
const FETCH_RELAY_TOKEN_ENV = "WEB_FETCH_RELAY_TOKEN";
const SEARCH_RELAY_URL_ENV = "WEB_SEARCH_RELAY_URL";
const SEARCH_RELAY_TOKEN_ENV = "WEB_SEARCH_RELAY_TOKEN";
const DEFAULT_MAX_RESPONSE_BYTES = 750_000;
const MAX_ERROR_BYTES = 64_000;

type FetchRelayPayload = {
  status?: unknown;
  url?: unknown;
  content_type?: unknown;
  text?: unknown;
  truncated?: unknown;
};

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function parseHttpUrl(value: string, envName: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid ${envName}: must be http or https`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Invalid ${envName}: must be http or https`);
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function resolveFetchMaxResponseBytes(fetchConfig?: Record<string, unknown>): number {
  const value = fetchConfig?.maxResponseBytes;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_MAX_RESPONSE_BYTES;
}

function looksLikeHtml(value: string): boolean {
  const head = value.trimStart().slice(0, 256).toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html");
}

async function runRelayWebFetch(params: {
  relayUrl: string;
  token?: string;
  requestedUrl: string;
  extractMode: "markdown" | "text";
  timeoutSeconds: number;
  maxResponseBytes: number;
  signal?: AbortSignal;
}): Promise<Record<string, unknown>> {
  const relayUrl = parseHttpUrl(params.relayUrl, FETCH_RELAY_URL_ENV);
  const requestedUrl = parseHttpUrl(params.requestedUrl, "URL");
  // The relay fetches this target outside Gateway's guarded direct-fetch path.
  // Reject private/special-use targets here; the relay must repeat this check at egress.
  await resolvePinnedHostnameWithPolicy(requestedUrl.hostname);
  relayUrl.searchParams.set("url", params.requestedUrl);
  relayUrl.searchParams.set("timeout", String(params.timeoutSeconds));
  relayUrl.searchParams.set("wait_for", "domcontentloaded");

  const startedAt = Date.now();
  const relayResponse = await withTrustedWebToolsEndpoint(
    {
      url: relayUrl.toString(),
      timeoutSeconds: params.timeoutSeconds,
      signal: params.signal,
      init: {
        headers: {
          Accept: "application/json",
          ...(params.token ? { "x-token": params.token } : {}),
        },
      },
    },
    async ({ response }) => ({
      response,
      body: await readResponseText(response, {
        maxBytes: Math.max(MAX_ERROR_BYTES, params.maxResponseBytes * 2),
      }),
    }),
  );

  if (relayResponse.body.truncated) {
    throw new Error(
      `Web fetch relay response incomplete after ${relayResponse.body.bytesRead} bytes.`,
    );
  }
  if (!relayResponse.response.ok) {
    throw new Error(
      `Web fetch relay failed (${relayResponse.response.status}): ${
        truncateText(relayResponse.body.text.trim() || relayResponse.response.statusText, 4_000)
          .text
      }`,
    );
  }

  let payload: FetchRelayPayload;
  try {
    const parsed: unknown = JSON.parse(relayResponse.body.text);
    if (!isRecord(parsed)) {
      throw new Error("non-object payload");
    }
    payload = parsed;
  } catch {
    throw new Error("Web fetch relay returned invalid JSON.");
  }

  const contentType =
    typeof payload.content_type === "string"
      ? payload.content_type.split(";", 1)[0]?.trim().toLowerCase()
      : undefined;
  const rawText = typeof payload.text === "string" ? payload.text : "";
  const finalUrl = typeof payload.url === "string" ? payload.url : undefined;
  let text = rawText;
  let title: string | undefined;
  let extractor = "relay";

  if (contentType?.includes("text/markdown")) {
    extractor = "relay-markdown";
    text = params.extractMode === "text" ? markdownToText(rawText) : rawText;
  } else if (contentType?.includes("text/html") || looksLikeHtml(rawText)) {
    const basic = await extractBasicHtmlContent({ html: rawText, extractMode: params.extractMode });
    if (!basic?.text) {
      throw new Error("Web fetch relay extraction failed: HTML cleanup returned no content.");
    }
    text = basic.text;
    title = basic.title;
    extractor = "relay-html";
  } else if (contentType?.includes("application/json")) {
    try {
      text = JSON.stringify(JSON.parse(rawText), null, 2);
      extractor = "relay-json";
    } catch {
      text = rawText;
    }
  }

  const status =
    typeof payload.status === "number" && Number.isFinite(payload.status)
      ? Math.max(0, Math.floor(payload.status))
      : 200;
  return {
    status,
    ...(finalUrl ? { finalUrl } : {}),
    ...(contentType ? { contentType } : {}),
    ...(title ? { title } : {}),
    extractor,
    text,
    rawLength: text.length,
    truncated: payload.truncated === true,
    ...(payload.truncated === true
      ? { warning: "Relay response body was truncated upstream." }
      : {}),
    tookMs: Date.now() - startedAt,
  };
}

async function runRelayWebSearch(params: {
  relayUrl: string;
  token?: string;
  args: Record<string, unknown>;
  searchConfig?: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<Record<string, unknown>> {
  const relayUrl = parseHttpUrl(params.relayUrl, SEARCH_RELAY_URL_ENV);
  const cacheKey = buildSearchCacheKey([
    "platformclaw-relay",
    relayUrl.toString(),
    stableStringify(params.args),
  ]);
  const cached = readCachedSearchPayload(cacheKey);
  if (cached) {
    return cached;
  }

  const payload = await withTrustedWebSearchEndpoint(
    {
      url: relayUrl.toString(),
      timeoutSeconds: resolveSearchTimeoutSeconds(params.searchConfig),
      signal: params.signal,
      init: {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(params.token ? { "x-token": params.token } : {}),
        },
        body: JSON.stringify(params.args),
      },
    },
    async (response) => {
      const body = await readResponseText(response, { maxBytes: 1_000_000 });
      if (body.truncated) {
        throw new Error(`Web search relay response incomplete after ${body.bytesRead} bytes.`);
      }
      if (!response.ok) {
        throw new Error(
          `Web search relay failed (${response.status}): ${
            truncateText(body.text.trim() || response.statusText, 4_000).text
          }`,
        );
      }
      try {
        const parsed: unknown = JSON.parse(body.text);
        if (!isRecord(parsed)) {
          throw new Error("non-object payload");
        }
        return parsed;
      } catch {
        throw new Error("Web search relay returned invalid JSON.");
      }
    },
  );

  writeCachedSearchPayload(cacheKey, payload, resolveSearchCacheTtlMs(params.searchConfig));
  return payload;
}

export function createPlatformClawRelayWebFetchProvider(): WebFetchProviderPlugin {
  return {
    id: PROVIDER_ID,
    label: "PlatformClaw Web Relay",
    hint: "Operator-configured web fetch relay",
    executionMode: "primary",
    requiresCredential: true,
    credentialLabel: "Web fetch relay URL",
    envVars: [FETCH_RELAY_URL_ENV],
    placeholder: "https://relay.example/fetch",
    signupUrl: "https://docs.openclaw.ai/tools/web-fetch",
    autoDetectOrder: -100,
    credentialPath: "",
    getCredentialValue: () => undefined,
    setCredentialValue: () => undefined,
    createTool: ({ fetchConfig }) => {
      const relayUrl = readEnv(FETCH_RELAY_URL_ENV);
      if (!relayUrl) {
        return null;
      }
      return {
        description: "Fetch a page through the PlatformClaw web relay.",
        parameters: Type.Object({}, { additionalProperties: true }),
        execute: async (args, context) => {
          const token = readEnv(FETCH_RELAY_TOKEN_ENV);
          return await runRelayWebFetch({
            relayUrl,
            ...(token ? { token } : {}),
            requestedUrl: typeof args.url === "string" ? args.url : "",
            extractMode: args.extractMode === "text" ? "text" : "markdown",
            timeoutSeconds: resolveTimeoutSeconds(
              typeof fetchConfig?.timeoutSeconds === "number"
                ? fetchConfig.timeoutSeconds
                : undefined,
              DEFAULT_TIMEOUT_SECONDS,
            ),
            maxResponseBytes: resolveFetchMaxResponseBytes(fetchConfig),
            ...(context?.signal ? { signal: context.signal } : {}),
          });
        },
      };
    },
  };
}

export function createPlatformClawRelayWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: PROVIDER_ID,
    label: "PlatformClaw Web Relay",
    hint: "Operator-configured web search relay",
    fallbackMode: "exclusive",
    onboardingScopes: ["text-inference"],
    requiresCredential: true,
    credentialLabel: "Web search relay URL",
    envVars: [SEARCH_RELAY_URL_ENV],
    placeholder: "https://relay.example/search",
    signupUrl: "https://docs.openclaw.ai/tools/web",
    autoDetectOrder: -100,
    credentialPath: "",
    ...createWebSearchProviderContractFields({
      credentialPath: "",
      searchCredential: { type: "scoped", scopeId: PROVIDER_ID },
      selectionPluginId: "platformclaw-web-relay",
    }),
    createTool: ({ searchConfig }) => {
      const relayUrl = readEnv(SEARCH_RELAY_URL_ENV);
      if (!relayUrl) {
        return null;
      }
      return {
        description: "Search the web through the PlatformClaw web relay.",
        parameters: Type.Object(
          {
            query: Type.String({ description: "Search query." }),
            count: Type.Optional(Type.Number({ minimum: 1, maximum: 10 })),
            country: Type.Optional(Type.String()),
            language: Type.Optional(Type.String()),
            freshness: Type.Optional(Type.String()),
          },
          { additionalProperties: true },
        ),
        execute: async (args, context) => {
          const token = readEnv(SEARCH_RELAY_TOKEN_ENV);
          const signal = context?.signal;
          return await runRelayWebSearch({
            relayUrl,
            ...(token ? { token } : {}),
            args,
            searchConfig,
            ...(signal ? { signal } : {}),
          });
        },
      };
    },
  };
}
