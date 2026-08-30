/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { i18n } from "../../i18n/index.ts";
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
  personalTargets: [{ kind: "part", scopeId: "part-1", scopeName: "Runtime", mode: "request" }],
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

beforeEach(async () => {
  await i18n.setLocale("en");
});

afterEach(async () => {
  document.body.innerHTML = "";
  await i18n.setLocale("en");
});

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
    await waitForFast(() => expect(element.textContent).toContain("revision 1"));
    expect(request).toHaveBeenCalledWith("platformclaw.memory.lifecycle", {});
    expect(element.textContent).toContain("Share Wiki knowledge");
    expect(element.textContent).toContain("Approve");
    expect(element.textContent).toContain("Runtime");
    expect(element.textContent).toContain("runbooks/recovery.md");
    expect(element.textContent).toContain("revision 1");
    expect(element.textContent).toContain("incident-42");
    expect(element.textContent).toContain("Needs newer evidence");
    expect(
      element.querySelector(".memory-promotions__source-row > .settings-row__control > select"),
    ).not.toBeNull();
    element.remove();
  });

  it("collects an explicit decision reason in an accessible modal", async () => {
    const request = vi.fn(async (method: string) =>
      method === "platformclaw.memory.lifecycle" ? snapshot : { status: "approved" },
    );
    const element = createElement(request);
    await waitForFast(() => expect(element.textContent).toContain("Drain jobs before restart"));

    [...element.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Approve")!
      .click();
    await element.updateComplete;
    const dialog = element.querySelector("openclaw-modal-dialog")!;
    const reason = dialog.querySelector<HTMLTextAreaElement>('textarea[name="reason"]')!;
    reason.value = "Verified against the incident record";
    dialog
      .querySelector("form")!
      .dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));

    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("platformclaw.memory.promotion.decide", {
        requestId: "request-1",
        decision: "approve",
        reason: "Verified against the incident record",
      }),
    );
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

  it("uses server-projected Team targets and renders Korean without translating claim text", async () => {
    await i18n.setLocale("ko");
    const request = vi.fn(async (method: string) =>
      method === "platformclaw.memory.lifecycle"
        ? {
            ...snapshot,
            claims: [
              {
                id: "team-claim",
                scopeKind: "team",
                scopeId: "team-1",
                scopeName: "Company",
                title: "Release policy",
                text: "Keep this English body",
                revision: 1,
                status: "active",
                createdAt: 1,
                updatedAt: 1,
                promotionTargets: [{ kind: "global", scopeName: "Global", mode: "direct" }],
                canRetire: true,
                canPurge: false,
              },
              {
                id: "managed-only-team-claim",
                scopeKind: "team",
                scopeId: "managed-team-1",
                scopeName: "Managed only",
                title: "Managed descendant",
                text: "Visible for retirement only",
                revision: 1,
                status: "active",
                createdAt: 1,
                updatedAt: 1,
                promotionTargets: [],
                canRetire: true,
                canPurge: false,
              },
            ],
          }
        : { status: "approved" },
    );
    const element = createElement(request);
    await waitForFast(() => expect(element.textContent).toContain("Wiki 지식 공유"));
    const sourceKind = element.querySelectorAll<HTMLSelectElement>("select")[0]!;
    sourceKind.value = "team";
    sourceKind.dispatchEvent(new Event("change", { bubbles: true }));
    await element.updateComplete;
    const sourceClaim = element.querySelectorAll<HTMLSelectElement>("select")[1]!;
    expect([...sourceClaim.options].map((option) => option.value)).not.toContain(
      "managed-only-team-claim",
    );
    sourceClaim.value = "team-claim";
    sourceClaim.dispatchEvent(new Event("change", { bubbles: true }));
    await element.updateComplete;
    const target = element.querySelectorAll<HTMLSelectElement>("select")[2]!;
    target.value = "global";
    target.dispatchEvent(new Event("change", { bubbles: true }));
    await element.updateComplete;
    expect(element.textContent).toContain("관리자 권한으로 바로 등록");
    expect(element.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(
      "Keep this English body",
    );
    [...element.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("관리자 권한으로 바로 등록"))!
      .click();
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith(
        "platformclaw.memory.promotion.publishDirect",
        expect.objectContaining({ sourceKind: "team", targetKind: "global" }),
      ),
    );
    element.remove();
  });
});
