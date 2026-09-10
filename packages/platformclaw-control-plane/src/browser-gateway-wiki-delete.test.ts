import { describe, expect, it } from "vitest";
import { setupBrowserGatewayProxyTest as setup } from "./browser-gateway-proxy.test-harness.js";

const expectedContentHash = "a".repeat(64);
const path = "concepts/검토.md";

describe("personal Wiki deletion boundary", () => {
  it.each([true, false])(
    "pins the Agent and preserves refresh outcome %s",
    async (indexesRefreshed) => {
      const { binding, proxy, request, token } = await setup();
      request.mockResolvedValue({
        agentId: binding.agentId,
        path,
        deleted: true,
        indexesRefreshed,
        vaultPath: "/private",
      });
      await expect(
        proxy.request(token, "wiki.delete", { path, expectedContentHash }),
      ).resolves.toEqual({
        agentId: binding.agentId,
        path,
        deleted: true,
        indexesRefreshed,
      });
      expect(request).toHaveBeenCalledExactlyOnceWith("wiki.delete", {
        agentId: binding.agentId,
        path,
        expectedContentHash,
      });
    },
  );

  it.each([
    "MEMORY.md",
    "memory/day.md",
    "../concepts/a.md",
    "concepts/../a.md",
    "concepts//a.md",
    "concepts\\a.md",
    "concepts/a.md:stream",
    "index.md",
    "attachments/a.md",
    ...[0, 9, 10, 31].map((code) => `concepts/a${String.fromCharCode(code)}.md`),
  ])("rejects unsafe or non-Wiki path %s before dispatch", async (unsafePath) => {
    const { proxy, request, token } = await setup();
    await expect(
      proxy.request(token, "wiki.delete", { path: unsafePath, expectedContentHash }),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects foreign Agent, missing hash, and extra parameters before dispatch", async () => {
    const { proxy, request, token } = await setup();
    for (const params of [
      { path, expectedContentHash, agentId: "foreign" },
      { path },
      { path, expectedContentHash: "A".repeat(64) },
      { path, expectedContentHash, force: true },
    ]) {
      await expect(proxy.request(token, "wiki.delete", params)).rejects.toThrow();
    }
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    { agentId: "foreign" },
    { path: "concepts/other.md" },
    { deleted: false },
    { indexesRefreshed: "true" },
  ])("rejects mismatched deletion result %j", async (patch) => {
    const { binding, proxy, request, token } = await setup();
    request.mockResolvedValue({
      agentId: binding.agentId,
      path,
      deleted: true,
      indexesRefreshed: true,
      ...patch,
    });
    await expect(
      proxy.request(token, "wiki.delete", { path, expectedContentHash }),
    ).rejects.toMatchObject({ code: "upstream-result-denied" });
  });

  it.each([
    [{}, expectedContentHash],
    [{ fromLine: 2 }, expectedContentHash],
    [{ truncated: true }, expectedContentHash],
    [{ deletionUnavailableReason: "shared-vault" }, undefined],
    [{ deletionUnavailableReason: "page-too-large" }, undefined],
    [{ deletionUnavailableReason: "generated-page" }, undefined],
    [{ contentHash: "invalid" }, undefined],
  ])(
    "exposes whole-artifact revision metadata independently of preview slicing %j",
    async (patch, expected) => {
      const { proxy, request, token } = await setup();
      request.mockResolvedValue({
        corpus: "wiki",
        path,
        title: "Review",
        kind: "concept",
        content: "Full page",
        fromLine: 1,
        lineCount: 1,
        totalLines: 1,
        contentHash: expectedContentHash,
        ...patch,
      });
      const result = await proxy.request<Record<string, unknown>>(token, "wiki.get", {
        lookup: path,
      });
      expect(result.contentHash).toBe(expected);
    },
  );
});
