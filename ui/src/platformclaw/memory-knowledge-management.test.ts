/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrganizationKnowledgeSnapshot } from "../../../packages/platformclaw-control-plane/src/organization-memory-knowledge-contracts.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { i18n } from "../i18n/index.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import { loadPlatformClawLocale } from "./i18n.ts";
import "./memory-knowledge-management.ts";

type KnowledgeElement = HTMLElement & {
  client: GatewayBrowserClient;
  connected: boolean;
  methodAdvertised: boolean;
  generateAdvertised: boolean;
  decideAdvertised: boolean;
  applyAdvertised: boolean;
  agentId: string;
  updateComplete: Promise<unknown>;
};
const method = "platformclaw.memory.knowledge.";
const completedAt = Date.now() - 300_000;

function snapshot(): OrganizationKnowledgeSnapshot {
  return {
    scope: {
      id: "part-runtime",
      kind: "part",
      name: "Runtime",
      capabilities: {
        canReadReport: true,
        canGenerateReport: true,
        canReviewProposals: true,
        canApplyProposals: false,
      },
    },
    lastSuccess: {
      id: "report-shared",
      jobId: "job-success",
      completedAt,
      inputFingerprint: "inputs",
      inputStatus: "stale",
      summary: "Latest generated report",
      comparisons: [],
      bounds: {
        includedClaims: 2,
        totalEligibleClaims: 3,
        maxClaims: 20,
        maxTextChars: 4000,
        truncated: true,
      },
      coverage: {
        strategy: "candidate-pairs",
        policyVersion: "v1",
        candidatePairs: 3,
        comparedPairs: 1,
        hasUncomparedPairs: true,
      },
    },
    currentJob: {
      id: "job-shared",
      inputFingerprint: "new-inputs",
      status: "running",
      createdAt: completedAt,
    },
    proposals: [
      {
        id: "proposal-1",
        reportId: "report-shared",
        revision: 1,
        status: "pending",
        inputStatus: "current",
        sourceClaims: [
          {
            id: "claim-a",
            revision: 2,
            title: "Rule A",
            text: "# Rule A\n\nOriginal rule A",
            evidence: ["Recorded board v1 test"],
          },
          {
            id: "claim-b",
            revision: 1,
            title: "Rule B",
            text: "# Rule B\n\nOriginal rule B",
            evidence: [],
          },
        ],
        kind: "conflict",
        claimIds: ["claim-a", "claim-b"],
        claimRevisions: [
          { id: "claim-a", revision: 2 },
          { id: "claim-b", revision: 1 },
        ],
        summary: "Conflicting rules",
        proposedText: "Suggested rule",
      },
    ],
    history: [],
    hasMore: false,
  };
}

function mount(request: ReturnType<typeof vi.fn>) {
  const element = document.createElement(
    "platformclaw-memory-knowledge-management",
  ) as KnowledgeElement;
  Object.assign(element, {
    client: { request },
    connected: true,
    methodAdvertised: true,
    generateAdvertised: true,
    decideAdvertised: true,
    applyAdvertised: true,
    agentId: "personal-one",
  });
  document.body.append(element);
  return element;
}
function click(element: HTMLElement, label: string) {
  const button = [...element.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  expect(button).toBeDefined();
  button!.click();
}
beforeEach(async () => {
  await i18n.setLocale("en");
  await loadPlatformClawLocale();
});
afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("organization knowledge management", () => {
  it("separates originals and registered evidence from AI judgment for read-only oversight", async () => {
    const selected = snapshot();
    selected.scope.capabilities = {
      canReadReport: true,
      canGenerateReport: false,
      canReviewProposals: false,
      canApplyProposals: false,
    };
    selected.proposals[0].sourceClaims[0].textTruncated = true;
    const request = vi
      .fn()
      .mockResolvedValue({ scopes: [selected.scope], selected, scopesHasMore: false });
    const element = mount(request);
    await waitForFast(() =>
      expect(element.querySelector("[data-knowledge-comparison]")).not.toBeNull(),
    );
    expect(element.querySelectorAll(".knowledge-comparison__source")).toHaveLength(2);
    expect(element.querySelector(".knowledge-comparison__source")?.textContent).toContain(
      "Recorded board v1 test",
    );
    expect(element.querySelector(".knowledge-comparison__source blockquote")?.textContent).toBe(
      selected.proposals[0].sourceClaims[0].text,
    );
    expect(element.querySelector(".knowledge-comparison__evidence")?.textContent).toBe(
      "Recorded board v1 test",
    );
    expect(element.querySelectorAll(".knowledge-comparison__source")[1].textContent).toContain(
      "No evidence is registered",
    );
    expect(element.querySelector(".knowledge-comparison__judgment")?.textContent).toContain(
      "AI comparison judgment",
    );
    expect(element.textContent).toContain("This is not the complete original");
    const labels = [...element.querySelectorAll("button")].map((button) =>
      button.textContent?.trim(),
    );
    expect(labels).not.toContain("Get knowledge report");
    expect(labels).not.toContain("Approve proposal");
    expect(request.mock.calls.every((call) => call[0] === `${method}snapshot`)).toBe(true);
  });
  it("bounds visible running-job status reads and stops after disconnection without model generation", async () => {
    vi.useFakeTimers();
    const selected = snapshot();
    const request = vi.fn(async (_method: string) => ({
      scopes: [selected.scope],
      selected,
      scopesHasMore: false,
    }));
    const element = mount(request);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(302_000);
    expect(request).toHaveBeenCalledTimes(151);
    expect(element.textContent).toContain("Automatic status checks stopped after five minutes");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(request).toHaveBeenCalledTimes(151);
    expect(request.mock.calls.every((call) => call[0] === `${method}snapshot`)).toBe(true);
    element.remove();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(request).toHaveBeenCalledTimes(151);
  });

  it("stops status polling when the server job completes", async () => {
    vi.useFakeTimers();
    const selected = snapshot();
    const response = { scopes: [selected.scope], selected, scopesHasMore: false };
    const request = vi
      .fn()
      .mockResolvedValueOnce(response)
      .mockResolvedValue({
        ...response,
        selected: {
          ...selected,
          currentJob: { ...selected.currentJob, status: "succeeded", completedAt },
        },
      });
    mount(request);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.every((call) => call[0] === `${method}snapshot`)).toBe(true);
  });
  it("clears prior report when a fresh scope read is rejected", async () => {
    const selected = snapshot();
    const request = vi
      .fn()
      .mockResolvedValueOnce({ scopes: [selected.scope], selected, scopesHasMore: false })
      .mockRejectedValueOnce(new Error("Report access no longer available"));
    const element = mount(request);
    await waitForFast(() => expect(element.textContent).toContain("Latest generated report"));
    click(element, "Check status / refresh");
    await waitForFast(() =>
      expect(element.textContent).toContain("Report access no longer available"),
    );
    expect(element.querySelector("[data-knowledge-report]")).toBeNull();
    expect(element.querySelector("[data-knowledge-proposal]")).toBeNull();
    expect(request.mock.calls.some((call) => call[0] === `${method}generate`)).toBe(false);
  });
  it("reads shared success/running state without generation and retains success on failed regeneration", async () => {
    const selected = snapshot();
    const request = vi.fn(async (name: string) =>
      name === `${method}snapshot`
        ? { scopes: [selected.scope], selected, scopesHasMore: false }
        : {
            ...selected,
            currentJob: {
              ...selected.currentJob,
              status: "failed",
              completedAt: Date.now(),
              failure: { code: "analysis-failed", message: "Try regeneration" },
            },
          },
    );
    const element = mount(request);
    await waitForFast(() => expect(element.textContent).toContain("Latest generated report"));
    expect(request.mock.calls.map((call) => call[0])).toEqual([`${method}snapshot`]);
    expect(element.querySelector("[data-knowledge-job]")?.getAttribute("data-knowledge-job")).toBe(
      "job-shared",
    );
    expect(element.querySelector("time")?.getAttribute("datetime")).toBe(
      new Date(completedAt).toISOString(),
    );
    expect(element.textContent).toContain("Approved knowledge has changed");
    expect(element.textContent).toContain("Analyzed 2 of 3");
    expect(element.textContent).toContain("Compared 1 of 3 candidate pairs");
    expect(element.textContent).toContain("Some claim pairs were not compared");
    click(element, "Get knowledge report");
    await waitForFast(() => expect(element.textContent).toContain("Latest analysis failed"));
    click(element, "Regenerate report");
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(3));
    expect(element.textContent).toContain("Latest generated report");
    expect(request).toHaveBeenCalledWith(
      `${method}generate`,
      expect.objectContaining({
        scopeId: "part-runtime",
        force: true,
        requestId: expect.any(String),
      }),
    );
  });

  it("records explicit reasoned review and hides unsupported apply", async () => {
    const selected = snapshot();
    const request = vi.fn(async (name: string) =>
      name === `${method}snapshot`
        ? { scopes: [selected.scope], selected, scopesHasMore: false }
        : {
            ...selected,
            proposals: [{ ...selected.proposals[0], revision: 2, status: "approved" }],
            history: [
              {
                id: "review-1",
                proposalId: "proposal-1",
                revision: 2,
                decision: "approve",
                reason: "Checked citations",
                occurredAt: Date.now(),
              },
            ],
          },
    );
    const element = mount(request);
    await waitForFast(() => expect(element.textContent).toContain("Conflicting rules"));
    click(element, "Approve proposal");
    await waitForFast(() => expect(element.querySelector("textarea")).not.toBeNull());
    const form = element.querySelector("openclaw-modal-dialog form") as HTMLFormElement;
    (form.querySelector("textarea") as HTMLTextAreaElement).value = "Checked citations";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await waitForFast(() =>
      expect(element.querySelector("[data-knowledge-review]")).not.toBeNull(),
    );
    expect(request).toHaveBeenCalledWith(`${method}decide`, {
      scopeId: "part-runtime",
      proposalId: "proposal-1",
      expectedRevision: 1,
      decision: "approve",
      reason: "Checked citations",
    });
    expect(element.textContent).toContain("Checked citations");
    expect(
      [...element.querySelectorAll("button")].some(
        (button) => button.textContent?.trim() === "Apply approved proposal",
      ),
    ).toBe(false);
    expect(request.mock.calls.some((call) => call[0] === `${method}apply`)).toBe(false);
  });

  it("moves rejected proposals into server-filtered history with frozen comparison", async () => {
    const selected = snapshot();
    const rejected = { ...selected.proposals[0], status: "rejected" as const, revision: 2 };
    selected.proposals = [rejected];
    selected.history = [
      {
        id: "rejected-review",
        proposalId: rejected.id,
        revision: 2,
        decision: "reject",
        reason: "Unsupported version claim",
        occurredAt: completedAt,
        actorUserId: "leader-a",
        actorDisplayName: "Leader A",
        proposal: { ...rejected, summary: "Frozen original comparison" },
      },
    ];
    const request = vi
      .fn()
      .mockResolvedValue({ scopes: [selected.scope], selected, scopesHasMore: false });
    const element = mount(request);
    await waitForFast(() =>
      expect(element.querySelector("[data-knowledge-review]")).not.toBeNull(),
    );
    expect(element.querySelector("[data-knowledge-proposal]")).toBeNull();
    expect(element.textContent).toContain("Unsupported version claim");
    expect(element.textContent).toContain("Leader A");
    expect(element.textContent).toContain("Frozen original comparison");
    const filter = element.querySelector(
      'select[aria-label="Review history filter"]',
    ) as HTMLSelectElement;
    filter.value = "rejected";
    filter.dispatchEvent(new Event("change"));
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith(`${method}snapshot`, {
        scopeId: "part-runtime",
        historyDecision: "reject",
      }),
    );
    expect(request.mock.calls.every((call) => call[0] === `${method}snapshot`)).toBe(true);
  });

  it("replaces history pages and resets cursors when filter or scope changes", async () => {
    const selected = snapshot();
    selected.currentJob = null;
    const cursor = { occurredAt: completedAt, id: "review-first" };
    const review = (id: string) => ({
      id,
      proposalId: "proposal-1",
      revision: 1,
      decision: "reject" as const,
      reason: id,
      occurredAt: completedAt,
    });
    const otherScope = { ...selected.scope, id: "part-other", name: "Other" };
    const request = vi.fn(
      async (_name: string, params: { scopeId?: string; historyCursor?: unknown }) => ({
        scopes: [selected.scope, otherScope],
        scopesHasMore: false,
        selected: {
          ...selected,
          scope: params.scopeId === "part-other" ? otherScope : selected.scope,
          history: [review(params.historyCursor ? "review-next" : "review-first")],
          ...(params.historyCursor ? {} : { nextHistoryCursor: cursor }),
        },
      }),
    );
    const element = mount(request);
    await waitForFast(() =>
      expect(element.querySelector('[data-knowledge-review="review-first"]')).not.toBeNull(),
    );
    click(element, "Next reviews");
    await waitForFast(() =>
      expect(element.querySelector('[data-knowledge-review="review-next"]')).not.toBeNull(),
    );
    expect(element.querySelector('[data-knowledge-review="review-first"]')).toBeNull();
    expect(request).toHaveBeenLastCalledWith(`${method}snapshot`, {
      scopeId: "part-runtime",
      historyCursor: cursor,
    });
    const filter = element.querySelector(
      'select[aria-label="Review history filter"]',
    ) as HTMLSelectElement;
    filter.value = "rejected";
    filter.dispatchEvent(new Event("change"));
    await waitForFast(() =>
      expect(request).toHaveBeenLastCalledWith(`${method}snapshot`, {
        scopeId: "part-runtime",
        historyDecision: "reject",
      }),
    );
    const scope = element.querySelector(
      'select[aria-label="Knowledge scope"]',
    ) as HTMLSelectElement;
    scope.value = "part-other";
    scope.dispatchEvent(new Event("change"));
    await waitForFast(() =>
      expect(request).toHaveBeenLastCalledWith(`${method}snapshot`, { scopeId: "part-other" }),
    );
  });

  it.each(["keep"] as const)(
    "records %s separately without applying knowledge",
    async (decision) => {
      const selected = snapshot();
      selected.proposals[0].status = "deferred";
      selected.proposals[0].revision = 2;
      const request = vi.fn(async (name: string) =>
        name === `${method}snapshot`
          ? { scopes: [selected.scope], selected, scopesHasMore: false }
          : {
              ...selected,
              proposals: [
                {
                  ...selected.proposals[0],
                  revision: 3,
                  status: "kept",
                },
              ],
              history: [
                {
                  id: "review-choice",
                  proposalId: "proposal-1",
                  revision: 3,
                  decision,
                  reason: "Keep version conditions",
                  occurredAt: completedAt,
                },
              ],
            },
      );
      const element = mount(request);
      await waitForFast(() => expect(element.textContent).toContain("Conflicting rules"));
      expect(
        [...element.querySelectorAll("button")].some(
          (button) => button.textContent?.trim() === "Defer",
        ),
      ).toBe(false);
      click(element, "Keep separately");
      await waitForFast(() =>
        expect(element.querySelector("openclaw-modal-dialog form")).not.toBeNull(),
      );
      const form = element.querySelector("openclaw-modal-dialog form") as HTMLFormElement;
      (form.querySelector("textarea[name=reason]") as HTMLTextAreaElement).value =
        "Keep version conditions";
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await waitForFast(() =>
        expect(element.querySelector("[data-knowledge-review]")).not.toBeNull(),
      );
      expect(request).toHaveBeenCalledWith(`${method}decide`, {
        scopeId: "part-runtime",
        proposalId: "proposal-1",
        expectedRevision: 2,
        decision,
        reason: "Keep version conditions",
      });
      expect(
        request.mock.calls.some(
          (call) => call[0] === `${method}apply` || call[0] === `${method}generate`,
        ),
      ).toBe(false);
    },
  );

  it("shows originals and requires the selected reference, new content, and reason before apply", async () => {
    const selected = snapshot();
    selected.scope.capabilities.canApplyProposals = true;
    selected.proposals[0] = {
      ...selected.proposals[0],
      status: "approved",
      kind: "enrichment",
      revision: 2,
    };
    const request = vi.fn(async (name: string) =>
      name === `${method}snapshot`
        ? { scopes: [selected.scope], selected, scopesHasMore: false }
        : {
            ...selected,
            proposals: [{ ...selected.proposals[0], status: "applied", revision: 3 }],
            history: [
              {
                id: "apply-review",
                proposalId: "proposal-1",
                revision: 3,
                decision: "apply",
                reason: "Checked conditions",
                occurredAt: completedAt,
                outcome: { claimId: "claim-b", revision: 2 },
              },
            ],
          },
    );
    const element = mount(request);
    await waitForFast(() => expect(element.textContent).toContain("Apply approved proposal"));
    click(element, "Apply approved proposal");
    await element.updateComplete;
    expect(element.querySelector("openclaw-modal-dialog")?.textContent).toContain(
      "Original rule A",
    );
    expect(element.querySelector("openclaw-modal-dialog")?.textContent).toContain(
      "Original rule B",
    );
    const survivor = element.querySelector('[name="survivor"]') as HTMLSelectElement;
    survivor.value = "claim-b";
    survivor.dispatchEvent(new Event("change", { bubbles: true }));
    await element.updateComplete;
    const form = element.querySelector("openclaw-modal-dialog form") as HTMLFormElement;
    for (const [name, value] of [
      ["title", "Updated rule"],
      ["body", "New rule with checked conditions"],
    ]) {
      const input = form.querySelector(`[name="${name}"]`) as HTMLInputElement;
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    (form.querySelector('[name="reason"]') as HTMLTextAreaElement).value = "Checked conditions";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await waitForFast(() =>
      expect(element.querySelector('[data-knowledge-review="apply-review"]')).not.toBeNull(),
    );
    expect(request).toHaveBeenCalledWith(`${method}apply`, {
      scopeId: "part-runtime",
      proposalId: "proposal-1",
      expectedRevision: 2,
      survivorClaimId: "claim-b",
      proposedText: "# Updated rule\n\nNew rule with checked conditions",
      reason: "Checked conditions",
    });
    expect(element.textContent).toContain("Organization knowledge · r2");
  });
});
