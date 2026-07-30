import { describe, expect, it } from "vitest";
import { parseUserMcpServerPolicies } from "./config.js";

describe("parseUserMcpServerPolicies", () => {
  it("sorts administrator-approved servers and pins API-key headers", () => {
    expect(
      parseUserMcpServerPolicies({
        servers: {
          zeta: { auth: "oauth", scope: " read write " },
          alpha: { auth: "api_key", headerName: "X-Api-Key" },
        },
      }),
    ).toEqual([
      { serverName: "alpha", auth: "api_key", headerName: "X-Api-Key" },
      { serverName: "zeta", auth: "oauth", scope: "read write" },
    ]);
  });

  it("rejects malformed header names", () => {
    expect(() =>
      parseUserMcpServerPolicies({
        servers: { docs: { auth: "api_key", headerName: "Authorization\r\nInjected" } },
      }),
    ).toThrow("headerName");
  });
});
