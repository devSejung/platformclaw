import { describe, expect, it } from "vitest";
import { configuredRemoteUrl } from "./index.js";

describe("configuredRemoteUrl", () => {
  it.each(["bearer", "api_key"] as const)(
    "allows personal %s credentials over administrator-approved HTTP",
    (auth) => {
      expect(
        configuredRemoteUrl(
          { mcp: { servers: { private: { url: "http://mcp.example.test" } } } },
          "private",
          auth,
        ),
      ).toBe("http://mcp.example.test/");
    },
  );

  it("keeps personal OAuth on HTTPS", () => {
    expect(() =>
      configuredRemoteUrl(
        { mcp: { servers: { private: { url: "http://mcp.example.test" } } } },
        "private",
        "oauth",
      ),
    ).toThrow("OAuth");
    expect(
      configuredRemoteUrl(
        { mcp: { servers: { private: { url: "https://mcp.example.test" } } } },
        "private",
        "oauth",
      ),
    ).toBe("https://mcp.example.test/");
  });
});
