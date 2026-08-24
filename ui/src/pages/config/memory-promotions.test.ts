/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import "./memory-promotions.ts";

type MemoryPromotionsTestElement = HTMLElement & {
  client: GatewayBrowserClient | null;
  connected: boolean;
  methodAdvertised: boolean;
  wikiSearchAdvertised: boolean;
  wikiGetAdvertised: boolean;
  agentId: string | null;
  updateComplete: Promise<unknown>;
};

function createElement(request: (method: string, params: unknown) => Promise<unknown>) {
  const element = document.createElement(
    "openclaw-memory-promotions",
  ) as MemoryPromotionsTestElement;
  element.client = { request } as unknown as GatewayBrowserClient;
  element.connected = true;
  element.methodAdvertised = true;
  element.wikiSearchAdvertised = true;
  element.wikiGetAdvertised = true;
  element.agentId = "personal-agent";
  document.body.append(element);
  return element;
}

const snapshot = {
  scopes: [
    { kind: "global", name: "Global", canAdminister: true },
    {
      kind: "group",
      id: "group-1",
      name: "Platform",
      canAdminister: true,
    },
    {
      kind: "part",
      id: "part-1",
      parentScopeId: "group-1",
      name: "Runtime",
      canAdminister: true,
    },
  ],
  claims: [],
  submitted: [],
  reviewable: [
    {
      id: "request-1",
      sourceKind: "personal",
      sourceClaimId: "runbooks/recovery.md",
      sourceRevision: 1,
      targetKind: "part",
      targetScopeName: "Runtime",
      proposedText: "Drain jobs before restart",
      evidence: ["incident-1"],
      reason: "Reusable",
      status: "pending",
      createdAt: 1,
      canReview: true,
    },
  ],
  canApproveGlobal: true,
};

describe("MemoryPromotionsElement", () => {
  it("loads the Agent-pinned lifecycle and renders review actions", async () => {
    const request = vi.fn(async (method: string) =>
      method === "platformclaw.memory.lifecycle"
        ? {
            ...snapshot,
            submitted: [
              {
                ...snapshot.reviewable[0],
                status: "rejected",
                canReview: false,
                evidence: ["incident-42"],
                decisionReason: "Needs newer evidence",
              },
            ],
          }
        : {},
    );
    const element = createElement(request);
    await waitForFast(() => expect(element.textContent).toContain("Drain jobs before restart"));
    expect(request).toHaveBeenCalledWith("platformclaw.memory.lifecycle", {});
    expect(element.textContent).toContain("Share Wiki knowledge");
    expect(element.textContent).toContain("Approve");
    expect(element.textContent).toContain("Runtime");
    expect(element.textContent).toContain("runbooks/recovery.md");
    expect(element.textContent).toContain("revision 1");
    expect(element.textContent).toContain("incident-42");
    expect(element.textContent).toContain("Needs newer evidence");
    element.remove();
  });

  it("submits a personal claim only after selecting an authorized target", async () => {
    const request = vi.fn(async (method: string) =>
      method === "platformclaw.memory.lifecycle" ? snapshot : { status: "pending" },
    );
    const element = createElement(request);
    await waitForFast(() => expect(element.querySelectorAll("select").length).toBeGreaterThan(1));
    element.querySelector("openclaw-memory-promotion-source-picker")!.dispatchEvent(
      new CustomEvent("source-selected", {
        bubbles: true,
        detail: {
          lookup: "runbooks/recovery.md",
          title: "Recovery",
          content: "Drain jobs before restart",
          path: "runbooks/recovery.md",
        },
      }),
    );
    const target = element.querySelectorAll<HTMLSelectElement>("select")[1]!;
    target.value = "part-1";
    target.dispatchEvent(new Event("change", { bubbles: true }));
    const reason = element.querySelector<HTMLInputElement>(
      ".memory-promotions .memory-promotions__field input",
    )!;
    reason.value = "Reusable runbook";
    reason.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await element.updateComplete;
    element.querySelector<HTMLButtonElement>("button.primary")!.click();
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith(
        "platformclaw.memory.promotion.submit",
        expect.objectContaining({
          sourceKind: "personal",
          sourceClaimId: "runbooks/recovery.md",
          targetKind: "part",
          targetScopeId: "part-1",
        }),
      ),
    );
    element.remove();
  });

  it("continues only unfinished lifecycle lists without duplicating completed pages", async () => {
    const first = {
      ...snapshot,
      claims: [
        {
          id: "claim-1",
          scopeKind: "global",
          scopeName: "Global",
          title: "Policy",
          text: "Policy",
          revision: 1,
          status: "active",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      next: { submitted: 200 },
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce({ ...snapshot, claims: [], reviewable: [], next: undefined });
    const element = createElement(request);
    await waitForFast(() => expect(element.textContent).toContain("Load more"));
    [...element.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Load more"))!
      .click();
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request).toHaveBeenLastCalledWith("platformclaw.memory.lifecycle", {
      claims: 1,
      submitted: 200,
      reviewable: 1,
    });
    expect(element.textContent?.match(/Policy/gu)).toHaveLength(1);
    element.remove();
  });
});
