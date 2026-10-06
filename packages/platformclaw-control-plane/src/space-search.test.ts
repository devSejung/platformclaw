import { validateSessionsSearchParams } from "@openclaw/gateway-protocol";
import { describe, expect, it } from "vitest";
import { createSpaceTestFixture as fixture } from "./spaces.test-fixtures.js";

describe("Space keyword recall", () => {
  it.each(["personal", "shared"] as const)(
    "matches all keywords across notes and follows safe read offsets for %s agents",
    async (kind) => {
      const f = await fixture();
      const body = `${"İ".repeat(900)}😀${"x".repeat(119)}reset sequence ${"y".repeat(1500)}`;
      const page = f.store.spaces.createPage(f.alice.user.id, f.space.id, {
        title: "Clock bringup",
        body,
        requestId: "keyword-page",
      });
      const actor = {
        agentId: kind === "personal" ? f.alice.binding.agentId : f.space.agentId,
        ...(kind === "shared" ? { runId: "fixture-history" } : {}),
      };
      const search = await f.service.agentRead({
        ...actor,
        operation: "search",
        query: "  CLOCK\t RESET  ",
        spaceId: f.space.id,
      });
      expect(search).toMatchObject({
        count: 1,
        results: [{ pageId: page.id, bodyOffset: 900, pageRevision: page.revision }],
      });
      const [hit] = search.results as Array<{
        bodyOffset: number;
        pageRevision: number;
        snippet: string;
      }>;
      expect(hit!.snippet).toContain("reset sequence");
      expect(Buffer.from(hit!.snippet, "utf8").toString("utf8")).toBe(hit!.snippet);
      const read = await f.service.agentRead({
        ...actor,
        operation: "get",
        spaceId: f.space.id,
        pageId: page.id,
        bodyOffset: hit!.bodyOffset,
        pageRevision: hit!.pageRevision,
      });
      expect(read).toMatchObject({ page: { body: body.slice(900), bodyOffset: 900 } });
      expect(f.request).toHaveBeenCalledWith("sessions.search", {
        agentId: f.space.agentId,
        sessionKeys: [`agent:${f.space.agentId}:space:${f.page.id}`],
        query: "CLOCK RESET",
        limit: 10,
      });
      expect(
        await f.service.agentRead({ ...actor, operation: "search", query: "clock absent" }),
      ).toMatchObject({ results: [] });
    },
  );

  it("uses literal keyword AND matching for browser note search and native requests", async () => {
    const f = await fixture();
    const page = f.store.spaces.savePage(
      f.alice.user.id,
      f.space.id,
      f.page.id,
      "Bringup",
      "Clock recovery\nReset [ready]",
      f.page.revision,
    );
    f.request.mockImplementation(async (method, params) => {
      expect(method).toBe("sessions.search");
      expect(validateSessionsSearchParams(params)).toBe(true);
      expect(params).toMatchObject({ query: "reset clock [ready]" });
      return { results: [] };
    });
    expect(
      await f.service.search(
        f.alice.user.id,
        " reset  clock\n[ready] ",
        f.space.id,
        async () => {},
      ),
    ).toMatchObject({ results: [{ pageId: page.id, snippet: page.body }] });
  });

  it("keeps note matches inaccessible before authorization and after membership removal", async () => {
    const f = await fixture();
    f.store.spaces.savePage(
      f.alice.user.id,
      f.space.id,
      f.page.id,
      "Clock",
      "Reset sequence",
      f.page.revision,
    );
    expect(
      await f.service.agentRead({
        agentId: f.bob.binding.agentId,
        operation: "search",
        query: "clock reset",
      }),
    ).toMatchObject({ results: [] });
    expect(f.request).not.toHaveBeenCalled();
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "viewer", 1);
    f.request.mockImplementationOnce(async () => {
      f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, null, 2);
      return { results: [] };
    });
    await expect(
      f.service.agentRead({
        agentId: f.bob.binding.agentId,
        operation: "search",
        query: "clock reset",
      }),
    ).rejects.toThrow("unavailable");
  });
});
