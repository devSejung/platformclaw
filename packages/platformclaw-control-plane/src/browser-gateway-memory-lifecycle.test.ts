import { describe, expect, it, type Mock, vi } from "vitest";
import { NOW, setupBrowserGatewayProxyTest } from "./browser-gateway-proxy.test-harness.js";
import { ControlPlaneAuthorizationError, ControlPlaneStateError } from "./contracts.js";
import type { OrganizationMemoryLifecycle } from "./contracts.js";

function lifecycle(): OrganizationMemoryLifecycle {
  return {
    getOrganizationMemoryLifecycle: vi.fn<
      OrganizationMemoryLifecycle["getOrganizationMemoryLifecycle"]
    >(async () => ({
      scopes: [{ kind: "global", name: "Global", canAdminister: false }],
      personalTargets: [],
      claims: [],
      submitted: [],
      reviewable: [],
      canApproveGlobal: false,
    })),
    submitOrganizationMemoryPromotion: vi.fn<
      OrganizationMemoryLifecycle["submitOrganizationMemoryPromotion"]
    >(async (params) => ({
      id: "request-1",
      sourceKind: params.sourceKind,
      sourceClaimId: params.sourceClaimId,
      sourceRevision: params.expectedSourceRevision ?? 1,
      targetKind: params.targetKind,
      targetScopeName: "Runtime",
      proposedText: params.proposedText,
      evidence: params.evidence,
      reason: params.reason,
      status: "pending",
      createdAt: params.submittedAt,
      canReview: false,
    })),
    publishOrganizationMemoryDirect: vi.fn<
      OrganizationMemoryLifecycle["publishOrganizationMemoryDirect"]
    >(async (params) => ({
      id: "request-direct",
      sourceKind: params.sourceKind,
      sourceRevision: params.expectedSourceRevision ?? 1,
      targetKind: params.targetKind,
      targetScopeName: "Global",
      proposedText: params.proposedText,
      evidence: params.evidence,
      reason: params.reason,
      status: "approved",
      createdAt: params.publishedAt,
      decidedAt: params.publishedAt,
      decisionReason: params.reason,
      canReview: false,
    })),
    decideOrganizationMemoryPromotion: vi.fn<
      OrganizationMemoryLifecycle["decideOrganizationMemoryPromotion"]
    >(async (params) => ({
      id: params.requestId,
      sourceKind: "personal",
      sourceClaimId: "personal-note-1",
      sourceRevision: 1,
      targetKind: "part",
      targetScopeName: "Runtime",
      proposedText: "Known recovery procedure",
      evidence: [],
      reason: "Reusable",
      status: params.decision === "approve" ? "approved" : "rejected",
      createdAt: NOW,
      decidedAt: params.decidedAt,
      decisionReason: params.reason,
      canReview: false,
    })),
    retireOrganizationMemoryClaim: vi.fn<
      OrganizationMemoryLifecycle["retireOrganizationMemoryClaim"]
    >(async (params) => ({
      id: params.claimId,
      scopeKind: "part",
      scopeName: "Runtime",
      title: "Recovery",
      text: "Known recovery procedure",
      revision: 2,
      status: "retired",
      createdAt: NOW,
      updatedAt: params.retiredAt,
    })),
    purgeOrganizationMemoryClaim: vi.fn<
      OrganizationMemoryLifecycle["purgeOrganizationMemoryClaim"]
    >(async (params) => ({
      id: params.claimId,
      scopeKind: "part",
      scopeName: "Runtime",
      title: "Purged claim",
      text: "",
      revision: 3,
      status: "purged",
      createdAt: NOW,
      updatedAt: params.purgedAt,
    })),
  };
}

function mockOf(owner: OrganizationMemoryLifecycle, method: keyof OrganizationMemoryLifecycle) {
  return owner[method] as Mock;
}

describe("browser organization memory lifecycle", () => {
  it("pins lifecycle reads and writes to the authenticated personal agent", async () => {
    const owner = lifecycle();
    const { binding, proxy, request, token } = await setupBrowserGatewayProxyTest({
      organizationMemoryLifecycle: owner,
    });
    await expect(proxy.request(token, "platformclaw.memory.lifecycle", {})).resolves.toMatchObject({
      canApproveGlobal: false,
    });
    expect(mockOf(owner, "getOrganizationMemoryLifecycle")).toHaveBeenCalledWith(
      binding.agentId,
      {},
    );

    await expect(
      proxy.request(token, "platformclaw.memory.promotion.submit", {
        sourceKind: "personal",
        sourceClaimId: "personal-note-1",
        expectedSourceRevision: 1,
        targetKind: "part",
        targetScopeId: "scope-1",
        proposedText: "Known recovery procedure",
        evidence: ["incident-1"],
        reason: "Reusable",
      }),
    ).resolves.toMatchObject({ status: "pending" });
    expect(mockOf(owner, "submitOrganizationMemoryPromotion")).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: binding.agentId, submittedAt: NOW }),
    );
    await proxy.request(token, "platformclaw.memory.promotion.decide", {
      requestId: "request-1",
      decision: "approve",
      reason: "verified",
    });
    await proxy.request(token, "platformclaw.memory.claim.retire", {
      claimId: "claim-1",
      reason: "superseded",
    });
    expect(mockOf(owner, "decideOrganizationMemoryPromotion")).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: binding.agentId, decidedAt: NOW }),
    );
    expect(mockOf(owner, "retireOrganizationMemoryClaim")).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: binding.agentId, retiredAt: NOW }),
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("exposes hard purge only to a PlatformClaw administrator", async () => {
    const owner = lifecycle();
    const { binding, proxy, token } = await setupBrowserGatewayProxyTest({
      admin: true,
      organizationMemoryLifecycle: owner,
    });
    await proxy.request(token, "platformclaw.memory.claim.purge", {
      claimId: "claim-1",
      reason: "privacy request",
    });
    expect(mockOf(owner, "purgeOrganizationMemoryClaim")).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: binding.agentId, purgedAt: NOW }),
    );
  });

  it("accepts Team promotion fields and pins administrator direct publication", async () => {
    const owner = lifecycle();
    const { binding, proxy, token } = await setupBrowserGatewayProxyTest({
      admin: true,
      organizationMemoryLifecycle: owner,
    });
    await expect(
      proxy.request(token, "platformclaw.memory.promotion.publishDirect", {
        sourceKind: "team",
        sourceClaimId: "team-claim",
        expectedSourceRevision: 2,
        targetKind: "global",
        proposedText: "Reviewed policy",
        evidence: ["team review"],
        reason: "administrator publication",
      }),
    ).resolves.toMatchObject({ status: "approved", sourceKind: "team" });
    expect(mockOf(owner, "publishOrganizationMemoryDirect")).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: binding.agentId, publishedAt: NOW }),
    );
  });

  it("rejects browser-controlled agent identity and malformed lifecycle params", async () => {
    const owner = lifecycle();
    const { proxy, token } = await setupBrowserGatewayProxyTest({
      organizationMemoryLifecycle: owner,
    });
    await expect(
      proxy.request(token, "platformclaw.memory.lifecycle", { agentId: "foreign" }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    await expect(
      proxy.request(token, "platformclaw.memory.promotion.submit", {
        sourceKind: "personal",
        sourceClaimId: "personal-note-1",
        expectedSourceRevision: "1",
        targetKind: "part",
        targetScopeId: "scope-1",
        proposedText: "text",
        evidence: [],
        reason: "reason",
      }),
    ).rejects.toMatchObject({ code: "invalid-params" });
    expect(mockOf(owner, "submitOrganizationMemoryPromotion")).not.toHaveBeenCalled();
  });

  it("projects lifecycle results through an explicit browser-safe allowlist", async () => {
    const owner = lifecycle();
    mockOf(owner, "getOrganizationMemoryLifecycle").mockResolvedValue({
      scopes: [
        {
          kind: "global",
          name: "Global",
          canAdminister: false,
          serverPath: "/srv/private",
        },
      ],
      personalTargets: [],
      claims: [],
      submitted: [],
      reviewable: [
        {
          id: "request-personal",
          sourceKind: "personal",
          sourceClaimId: "private/wiki/path.md",
          sourceRevision: 1,
          targetKind: "part",
          targetScopeName: "Runtime",
          proposedText: "Safe shared text",
          evidence: [],
          reason: "review",
          status: "pending",
          createdAt: NOW,
          canReview: true,
        },
      ],
      canApproveGlobal: false,
      requestedByUserId: "secret-user",
      next: { submitted: 200, secretCursor: "private" },
    });
    const { proxy, token } = await setupBrowserGatewayProxyTest({
      organizationMemoryLifecycle: owner,
    });
    const result = await proxy.request(token, "platformclaw.memory.lifecycle", {});
    expect(JSON.stringify(result)).not.toContain("serverPath");
    expect(JSON.stringify(result)).not.toContain("requestedByUserId");
    expect(JSON.stringify(result)).not.toContain("secretCursor");
    expect(JSON.stringify(result)).not.toContain("private/wiki/path.md");
  });

  it("maps expected lifecycle failures to actionable sanitized browser errors", async () => {
    const owner = lifecycle();
    mockOf(owner, "submitOrganizationMemoryPromotion").mockRejectedValueOnce(
      new ControlPlaneStateError("source claim revision is no longer active"),
    );
    mockOf(owner, "decideOrganizationMemoryPromotion").mockRejectedValueOnce(
      new ControlPlaneAuthorizationError("promotion approval authority required"),
    );
    const { auditEvents, proxy, token } = await setupBrowserGatewayProxyTest({
      organizationMemoryLifecycle: owner,
    });
    await expect(
      proxy.request(token, "platformclaw.memory.promotion.submit", {
        sourceKind: "personal",
        sourceClaimId: "runbooks/recovery.md",
        targetKind: "part",
        targetScopeId: "scope-1",
        proposedText: "text",
        evidence: [],
        reason: "reason",
      }),
    ).rejects.toMatchObject({
      code: "invalid-params",
      message: "source claim revision is no longer active",
    });
    await expect(
      proxy.request(token, "platformclaw.memory.promotion.decide", {
        requestId: "request-1",
        decision: "approve",
        reason: "verified",
      }),
    ).rejects.toMatchObject({
      code: "cross-agent-denied",
      message: "promotion approval authority required",
    });
    expect(auditEvents).toEqual([
      expect.objectContaining({
        eventType: "browser.gateway.denied",
        details: expect.objectContaining({ reason: "invalid-params" }),
      }),
      expect.objectContaining({
        eventType: "browser.gateway.denied",
        details: expect.objectContaining({ reason: "cross-agent-denied" }),
      }),
    ]);
  });
});
