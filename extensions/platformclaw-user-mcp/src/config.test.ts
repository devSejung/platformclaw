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
      {
        serverName: "alpha",
        credentialMode: "personal",
        auth: "api_key",
        headerName: "X-Api-Key",
        headerGuides: [],
      },
      {
        serverName: "zeta",
        credentialMode: "personal",
        auth: "oauth",
        scope: "read write",
        headerGuides: [],
      },
    ]);
  });

  it("rejects malformed header names", () => {
    expect(() =>
      parseUserMcpServerPolicies({
        servers: { docs: { auth: "api_key", headerName: "Authorization\r\nInjected" } },
      }),
    ).toThrow("headerName");
  });

  it.each(["shared", "personal"] as const)(
    "rejects transport-owned primary API-key headers in %s policies",
    (credentialMode) => {
      for (const headerName of [
        "Host",
        "Content-Length",
        "Content-Type",
        "Accept",
        "Connection",
        "Transfer-Encoding",
        "Upgrade",
        "Te",
        "Trailer",
        "Keep-Alive",
        "Proxy-Authorization",
        "Proxy-Connection",
        "Mcp-Session-Id",
        "MCP-Protocol-Version",
        "Last-Event-Id",
        "X".repeat(129),
      ]) {
        expect(() =>
          parseUserMcpServerPolicies({
            servers: { docs: { credentialMode, auth: "api_key", headerName } },
          }),
        ).toThrow("headerName");
      }
      expect(
        parseUserMcpServerPolicies({
          servers: { docs: { credentialMode, auth: "api_key", headerName: " Authorization " } },
        }),
      ).toMatchObject([{ headerName: "Authorization" }]);
    },
  );

  it("normalizes common policies and optional user header guides without inventing personal auth", () => {
    expect(
      parseUserMcpServerPolicies({
        servers: {
          public: {
            credentialMode: "none",
            headerGuides: [{ name: " X-Tenant ", description: " Your tenant identifier " }],
          },
          shared: { credentialMode: "shared", auth: "bearer" },
          sharedKey: { credentialMode: "shared", auth: "api_key", headerName: "X-Api-Key" },
        },
      }),
    ).toEqual([
      {
        serverName: "public",
        credentialMode: "none",
        headerGuides: [{ name: "X-Tenant", description: "Your tenant identifier" }],
      },
      { serverName: "shared", credentialMode: "shared", auth: "bearer", headerGuides: [] },
      {
        serverName: "sharedKey",
        credentialMode: "shared",
        auth: "api_key",
        headerName: "X-Api-Key",
        headerGuides: [],
      },
    ]);
  });

  it.each([
    { credentialMode: "unknown" },
    { credentialMode: "none", auth: "bearer" },
    { credentialMode: "shared", auth: "oauth" },
    { credentialMode: "personal" },
    { credentialMode: "personal", auth: "password" },
  ])("rejects inconsistent credential policy %j", (policy) => {
    expect(() => parseUserMcpServerPolicies({ servers: { docs: policy } })).toThrow();
  });

  it.each(
    [
      "not-an-array",
      Array.from({ length: 33 }, (_, index) => ({ name: `X-Header-${index}` })),
      [null],
      [{ name: "" }],
      [{ name: "X-Tenant\r\nInjected" }],
      [{ name: "X-Tenant" }, { name: "x-tenant" }],
      [{ name: "X-Tenant", description: "line\nbreak" }],
      [{ name: "X-Tenant", description: "x".repeat(513) }],
      [{ name: "X-Tenant", description: 42 }],
    ].map((headerGuides) => ({ headerGuides })),
  )("rejects malformed or duplicated header guides %j", ({ headerGuides }) => {
    expect(() =>
      parseUserMcpServerPolicies({ servers: { docs: { credentialMode: "none", headerGuides } } }),
    ).toThrow("guide");
  });
});
