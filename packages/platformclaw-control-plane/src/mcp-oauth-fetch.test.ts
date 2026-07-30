import { describe, expect, it, vi } from "vitest";
import { createMcpOAuthFetch } from "./mcp-oauth-fetch.js";

describe("createMcpOAuthFetch", () => {
  it("rejects plaintext and private-network OAuth destinations", async () => {
    const oauthFetch = createMcpOAuthFetch();
    await expect(oauthFetch("http://auth.example.test/token")).rejects.toThrow("https");
    await expect(oauthFetch("https://127.0.0.1/token")).rejects.toThrow(/blocked|private|SSRF/i);
  });

  it("bounds OAuth response bodies", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ value: "x" }, { headers: { "content-length": "1048577" } }),
    );
    const oauthFetch = createMcpOAuthFetch(fetchImpl as typeof globalThis.fetch);
    await expect(oauthFetch("https://auth.example.test/token")).rejects.toThrow("too large");
  });
});
