import { describe, expect, it } from "vitest";
import { requestBrowserOrganizationMemoryGraph } from "../../../packages/platformclaw-control-plane/src/browser-gateway-organization-graph.js";
import {
  organizationMemoryGraphCases,
  organizationMemoryBusyGraphCases,
  organizationMemoryEmptyGraphCases,
} from "./platformclaw-organization-memory-fixture-data.ts";

describe("organization Memory fixture browser contracts", () => {
  for (const [variant, cases] of [
    ["base", organizationMemoryGraphCases],
    ["busy", organizationMemoryBusyGraphCases],
    ["empty", organizationMemoryEmptyGraphCases],
  ] as const) {
    it.each(cases)(
      `${variant} graph passes the real browser projection for $match`,
      async ({ match, response }) => {
        const projected = await requestBrowserOrganizationMemoryGraph({
          method: "platformclaw.memory.graph",
          request: match,
          agentId: "memory-owner",
          get: async () => response,
        });
        expect(projected).toMatchObject({
          handled: true,
          result: { kind: response.kind, stats: response.stats },
        });
      },
    );
  }
});
