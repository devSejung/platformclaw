import { describe, expect, it, vi } from "vitest";
import { skillProposalInspectResult } from "./browser-gateway-proxy.test-fixtures.js";
import {
  NOW,
  setupBrowserGatewayProxyTest as setup,
} from "./browser-gateway-proxy.test-harness.js";

describe("BrowserGatewayProxy Skill Workshop", () => {
  it("allows exact-revision evaluate and apply on the assigned VM", async () => {
    const { binding, proxy, request, store, token } = await setup();
    vi.spyOn(store, "getPersonalExecutionProfile").mockResolvedValue({
      agentBindingId: binding.id,
      activeTarget: "assigned_vm",
      activeAllocationId: "allocation-1",
      targetRevision: 1,
      updatedAt: NOW,
    });
    const inspected = skillProposalInspectResult(binding.agentId);
    const evaluation = {
      id: "evaluation-one",
      proposedVersion: "1.0.0",
      draftHash: "a".repeat(64),
      trigger: "manual",
      startedAt: "2026-08-01T00:00:00.000Z",
      completedAt: "2026-08-01T00:00:01.000Z",
      outcomes: [],
    };
    request.mockResolvedValueOnce({ record: inspected.record, evaluation }).mockResolvedValueOnce({
      record: { ...inspected.record, status: "applied" },
      targetSkillFile: "/private/vm/path/SKILL.md",
    });

    await expect(
      proxy.request(token, "skills.proposals.evaluate", {
        proposalId: "proposal-1",
        expectedRevisionHash: "b".repeat(64),
        correlationId: "ui-evaluation",
      }),
    ).resolves.toMatchObject({
      record: { target: { targetLabel: "Development VM" } },
      evaluation: { id: "evaluation-one" },
    });
    await expect(
      proxy.request(token, "skills.proposals.apply", {
        proposalId: "proposal-1",
        expectedRevisionHash: "b".repeat(64),
        correlationId: "ui-apply",
      }),
    ).resolves.toMatchObject({
      record: { status: "applied", target: { targetLabel: "Development VM" } },
      targetSkillFile: "calendar-reports/SKILL.md",
    });
    expect(request).toHaveBeenNthCalledWith(1, "skills.proposals.evaluate", {
      agentId: binding.agentId,
      proposalId: "proposal-1",
      expectedRevisionHash: "b".repeat(64),
      correlationId: "ui-evaluation",
    });
    expect(request).toHaveBeenNthCalledWith(2, "skills.proposals.apply", {
      agentId: binding.agentId,
      proposalId: "proposal-1",
      expectedRevisionHash: "b".repeat(64),
      correlationId: "ui-apply",
    });
  });
});
