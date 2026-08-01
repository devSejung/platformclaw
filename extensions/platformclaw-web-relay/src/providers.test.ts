import { mockPinnedHostnameResolution, withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPlatformClawRelayWebFetchProvider,
  createPlatformClawRelayWebSearchProvider,
} from "./providers.js";

describe("PlatformClaw web relay providers", () => {
  const originalFetch = global.fetch;
  let ssrfMock: ReturnType<typeof mockPinnedHostnameResolution>;

  beforeEach(() => {
    ssrfMock = mockPinnedHostnameResolution();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    ssrfMock.mockRestore();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("stays unavailable when relay URL variables are absent", () => {
    vi.stubEnv("WEB_FETCH_RELAY_URL", "");
    vi.stubEnv("WEB_SEARCH_RELAY_URL", "");

    expect(createPlatformClawRelayWebFetchProvider().createTool({})).toBeNull();
    expect(createPlatformClawRelayWebSearchProvider().createTool({})).toBeNull();
  });

  it("fetches through public relay without sending x-token", async () => {
    vi.stubEnv("WEB_FETCH_RELAY_URL", "https://relay.example/fetch");
    vi.stubEnv("WEB_FETCH_RELAY_TOKEN", "");
    const fetchMock = vi.fn(
      async (_input?: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            status: 200,
            url: "https://example.com/final",
            content_type: "text/markdown; charset=utf-8",
            text: "# Relay body",
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    global.fetch = withFetchPreconnect(fetchMock);

    const tool = createPlatformClawRelayWebFetchProvider().createTool({
      fetchConfig: { timeoutSeconds: 7 },
    });
    const result = await tool?.execute({
      url: "https://example.com/page",
      extractMode: "text",
      maxChars: 1_000,
    });

    const [input, init] = fetchMock.mock.calls[0] ?? [];
    if (input === undefined) {
      throw new Error("Expected relay fetch request.");
    }
    const requestUrl = new URL(input instanceof Request ? input.url : input);
    expect(requestUrl.origin + requestUrl.pathname).toBe("https://relay.example/fetch");
    expect(requestUrl.searchParams.get("url")).toBe("https://example.com/page");
    expect(requestUrl.searchParams.get("timeout")).toBe("7");
    expect(requestUrl.searchParams.get("wait_for")).toBe("domcontentloaded");
    expect(init?.headers).not.toHaveProperty("x-token");
    expect(result).toMatchObject({
      finalUrl: "https://example.com/final",
      contentType: "text/markdown",
      extractor: "relay-markdown",
      text: "Relay body",
    });
  });

  it("rejects private fetch targets before contacting the relay", async () => {
    vi.stubEnv("WEB_FETCH_RELAY_URL", "https://relay.example/fetch");
    const fetchMock = vi.fn();
    global.fetch = withFetchPreconnect(fetchMock);
    const tool = createPlatformClawRelayWebFetchProvider().createTool({});

    await expect(tool?.execute({ url: "http://127.0.0.1/admin" })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts search args and adds x-token only when configured", async () => {
    vi.stubEnv("WEB_SEARCH_RELAY_URL", "https://relay.example/search");
    vi.stubEnv("WEB_SEARCH_RELAY_TOKEN", "relay-token");
    const fetchMock = vi.fn(
      async (_input?: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            provider: "searxng",
            query: "platformclaw",
            results: [
              {
                title: "PlatformClaw",
                url: "https://example.com/platformclaw",
                description: "relay result",
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    global.fetch = withFetchPreconnect(fetchMock);

    const tool = createPlatformClawRelayWebSearchProvider().createTool({
      searchConfig: { cacheTtlMinutes: 0, timeoutSeconds: 9 },
    });
    const result = await tool?.execute({ query: "platformclaw", count: 5 });

    const [input, init] = fetchMock.mock.calls[0] ?? [];
    if (input === undefined) {
      throw new Error("Expected relay search request.");
    }
    expect(input instanceof Request ? input.url : input).toBe("https://relay.example/search");
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-token": "relay-token",
      },
      body: JSON.stringify({ query: "platformclaw", count: 5 }),
    });
    expect(result).toMatchObject({
      provider: "searxng",
      results: [{ title: "PlatformClaw" }],
    });
  });

  it("searches through a public relay without x-token", async () => {
    vi.stubEnv("WEB_SEARCH_RELAY_URL", "https://relay.example/public-search");
    vi.stubEnv("WEB_SEARCH_RELAY_TOKEN", "");
    const fetchMock = vi.fn(
      async (_input?: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ query: "public", results: [] }), {
          headers: { "content-type": "application/json" },
        }),
    );
    global.fetch = withFetchPreconnect(fetchMock);

    const tool = createPlatformClawRelayWebSearchProvider().createTool({
      searchConfig: { cacheTtlMinutes: 0 },
    });
    await tool?.execute({ query: "public" });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init?.headers).not.toHaveProperty("x-token");
  });
});
