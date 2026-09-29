import { afterEach, describe, expect, it } from "vitest";
import { BrowserAuthService } from "./browser-auth-service.js";
import type { BrowserGatewayProxyOptions } from "./browser-gateway-contracts.js";
import { requestBrowserKnowledgeSearch } from "./browser-knowledge-search.js";
import { createWikiHubTestFixture } from "./wiki-hub.test-fixtures.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) {
    await close();
  }
});

describe("Wiki Hub browser search scope", () => {
  it("excludes disabled Personal Wiki from connected browser search while retaining raw Memory and explicit browse", async () => {
    const f = await createWikiHubTestFixture();
    cleanup.push(f.close);
    const options: BrowserGatewayProxyOptions = {
      authService: new BrowserAuthService({
        store: f.store,
        authenticator: {
          authenticatePassword: async () => ({ status: "rejected", message: "unused" }),
        },
        provisioner: { provisionOrRefresh: async () => {} },
      }),
      store: f.store,
      auditWriter: f.store,
      gateway: { request: f.request },
      vaultService: f.service,
      buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
      resolveAgentIdFromSessionKey: () => null,
    };
    const access = {
      user: f.user,
      binding: f.binding,
      mainSessionKey: `agent:${f.binding.agentId}:main`,
    };
    const connected = await requestBrowserKnowledgeSearch(options, access, "memory.search", {
      query: "Calibration",
    });
    expect(connected).toMatchObject({
      handled: true,
      result: {
        results: expect.arrayContaining([
          expect.objectContaining({ source: "memory" }),
          expect.objectContaining({ source: "shared" }),
        ]),
      },
    });
    expect(f.request.mock.calls.map(([method]) => method)).toEqual(["memory.search"]);
    for (const selection of [{ scope: "all" }, { vaultId: `personal:${f.binding.agentId}` }]) {
      f.request.mockClear();
      const result = await requestBrowserKnowledgeSearch(options, access, "wiki.search", {
        query: "Calibration",
        ...selection,
      });
      expect(result).toMatchObject({
        handled: true,
        result: expect.arrayContaining([expect.objectContaining({ source: "wiki" })]),
      });
      expect(f.request).toHaveBeenCalledWith(
        "wiki.search",
        expect.objectContaining({ vaultId: `personal:${f.binding.agentId}` }),
      );
    }
  });
});
