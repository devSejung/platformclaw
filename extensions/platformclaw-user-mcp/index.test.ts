import { describe, expect, it } from "vitest";
import { configuredHttpUrl } from "./index.js";

describe("configuredHttpUrl", () => {
  it("requires HTTPS for servers receiving personal credentials", () => {
    expect(() =>
      configuredHttpUrl(
        { mcp: { servers: { private: { url: "http://mcp.example.test" } } } },
        "private",
      ),
    ).toThrow("HTTPS");
    expect(
      configuredHttpUrl(
        { mcp: { servers: { private: { url: "https://mcp.example.test" } } } },
        "private",
      ),
    ).toBe("https://mcp.example.test/");
  });
});
