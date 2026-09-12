import { describe, expect, it, vi } from "vitest";
import { requestBrowserOrganizationKnowledge } from "./browser-gateway-knowledge.js";
import type { OrganizationKnowledgeService } from "./organization-knowledge-service.js";
import type { SqliteControlPlaneStore } from "./sqlite-store.js";

describe("organization knowledge browser boundary", () => {
  function fixture() {
    const snapshot = vi.fn().mockResolvedValue({ selected: null });
    const decide = vi.fn();
    const store = {
      getOrganizationKnowledgeSnapshot: snapshot,
      decideOrganizationKnowledgeProposal: decide,
    } as unknown as SqliteControlPlaneStore;
    const request = (method: string, body: Record<string, unknown>) =>
      requestBrowserOrganizationKnowledge({
        store,
        service: {} as OrganizationKnowledgeService,
        agentId: "authenticated-agent",
        method: `platformclaw.memory.knowledge.${method}`,
        request: body,
        now: 123,
      });
    return { snapshot, decide, request };
  }

  it("forwards bounded history scope/filter/cursor with authenticated actor", async () => {
    const f = fixture();
    await f.request("snapshot", {
      agentId: "injected-actor",
      scopeId: "scope",
      historyDecision: "reject",
      historyCursor: { occurredAt: 200, id: "review-01" },
    });
    expect(f.snapshot).toHaveBeenCalledWith({
      agentId: "authenticated-agent",
      scopeId: "scope",
      historyDecision: "reject",
      historyCursor: { occurredAt: 200, id: "review-01" },
    });
  });

  it("rejects new defer actions and malformed history reads before dispatch", async () => {
    const f = fixture();
    await expect(
      f.request("decide", {
        scopeId: "scope",
        decision: "defer",
        proposalId: "proposal",
        expectedRevision: 0,
        reason: "Hold",
      }),
    ).rejects.toThrow("approve, reject or keep");
    for (const body of [
      { historyDecision: "keep" },
      { historyCursor: [] },
      { historyCursor: { occurredAt: -1, id: "review" } },
      { historyCursor: { occurredAt: 1, id: "x".repeat(129) } },
      { historyCursor: { occurredAt: 1.2, id: "review" } },
    ]) {
      await expect(f.request("snapshot", body)).rejects.toThrow();
    }
    expect(f.snapshot).not.toHaveBeenCalled();
    expect(f.decide).not.toHaveBeenCalled();
  });
});
