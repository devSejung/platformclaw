import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./i18n.ts", () => ({
  platformClawT: (key: string) => key,
}));

import "./organization-join-panel.ts";

type JoinPanel = HTMLElement & {
  fetchImpl: typeof fetch;
  search(query: string): void;
  submit(reason: string): Promise<void>;
  updateComplete: Promise<unknown>;
  requestUpdate(): void;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

function requestBody(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== "string") {
    throw new TypeError("expected a JSON request body");
  }
  return JSON.parse(init.body) as unknown;
}

function scopeResult() {
  const scope = { id: "team-1", kind: "team", name: "Platform", status: "active" };
  return {
    ...scope,
    revision: 4,
    lineage: [scope],
    capabilities: {
      canManageMembers: false,
      canManageStructure: false,
      canManageLeaders: false,
    },
    requestEligible: true,
    requestState: "eligible" as const,
  };
}

function reviewRequest(id: string) {
  return {
    request: {
      id,
      scopeId: "team-1",
      reason: `Join ${id}`,
      status: "pending",
      createdAt: 10,
    },
    applicant: { id: `user-${id}`, accountId: id, displayName: id },
    scope: scopeResult(),
    lineage: scopeResult().lineage,
  };
}

async function settle(element: JoinPanel): Promise<void> {
  await element.updateComplete;
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  await element.updateComplete;
}

afterEach(() => document.body.replaceChildren());

describe("PlatformClaw organization requests", () => {
  it("shows a retry after initial loading fails and recovers without a false empty state", async () => {
    let failed = false;
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = requestUrl(input);
      if (url.endsWith("/context") && !failed) {
        failed = true;
        return json({ error: { code: "unavailable" } }, 503);
      }
      if (url.endsWith("/context")) {
        return json({ canReviewJoinRequests: false });
      }
      if (url.includes("/scopes?")) {
        return json({ items: [scopeResult()], hasMore: false });
      }
      if (url.includes("/requests/own")) {
        return json({ items: [] });
      }
      throw new Error(`unexpected request ${url}`);
    });
    const element = document.createElement("platformclaw-organization-join-panel") as JoinPanel;
    element.fetchImpl = fetchImpl;
    document.body.append(element);
    await settle(element);

    expect(element.querySelector('[role="alert"]')).not.toBeNull();
    element.querySelector<HTMLButtonElement>('[role="alert"] button')!.click();
    await settle(element);
    expect(element.querySelector('[role="alert"]')).toBeNull();
    expect(element.textContent).toContain("Platform");
  });

  it("ignores a stale failed scope search after a newer result succeeds", async () => {
    let rejectOld!: (reason: unknown) => void;
    const oldSearch = new Promise<Response>((_resolve, reject) => {
      rejectOld = reject;
    });
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = requestUrl(input);
      if (url.endsWith("/context")) {
        return json({ canReviewJoinRequests: false });
      }
      if (url.includes("q=old")) {
        return oldSearch;
      }
      if (url.includes("q=new")) {
        const next = {
          id: "team-new",
          kind: "team" as const,
          name: "New Team",
          status: "active" as const,
        };
        return json({
          items: [{ ...scopeResult(), ...next, lineage: [next] }],
          hasMore: false,
        });
      }
      if (url.includes("/scopes?")) {
        return json({ items: [scopeResult()], hasMore: false });
      }
      if (url.includes("/requests/own")) {
        return json({ items: [] });
      }
      throw new Error(`unexpected request ${url}`);
    });
    const element = document.createElement("platformclaw-organization-join-panel") as JoinPanel;
    element.fetchImpl = fetchImpl;
    document.body.append(element);
    await settle(element);

    element.search("old");
    element.search("new");
    await settle(element);
    rejectOld(new TypeError("stale request failed"));
    await settle(element);

    expect(element.textContent).toContain("New Team");
    expect(element.querySelector('[role="alert"]')).toBeNull();
  });

  it("submits one reasoned join request and refreshes its authoritative history", async () => {
    let pending = false;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = requestUrl(input);
      if (url.endsWith("/context")) {
        return json({ canReviewJoinRequests: false });
      }
      if (url.includes("/scopes?")) {
        return json({
          items: [
            {
              ...scopeResult(),
              requestEligible: !pending,
              requestState: pending ? "pending" : "eligible",
            },
          ],
          hasMore: false,
        });
      }
      if (url.includes("/requests/own")) {
        return json({
          items: pending
            ? [
                {
                  request: {
                    id: "request-1",
                    scopeId: "team-1",
                    reason: "Work with Platform",
                    status: "pending",
                    createdAt: 10,
                  },
                  scope: scopeResult(),
                  lineage: scopeResult().lineage,
                },
              ]
            : [],
        });
      }
      if (url.includes("/requests/reviewable")) {
        return json({ items: [] });
      }
      if (url.endsWith("/requests") && init?.method === "POST") {
        pending = true;
        expect(requestBody(init)).toEqual({
          scopeId: "team-1",
          reason: "Work with Platform",
        });
        return json({ id: "request-1", status: "pending" });
      }
      throw new Error(`unexpected request ${url}`);
    });
    const element = document.createElement("platformclaw-organization-join-panel") as JoinPanel;
    element.fetchImpl = fetchImpl;
    document.body.append(element);
    await settle(element);

    element.querySelector<HTMLButtonElement>(".organization-request-list .primary")!.click();
    await settle(element);
    const form = element.querySelector<HTMLFormElement>(".organization-action-form")!;
    form.querySelector<HTMLTextAreaElement>("textarea")!.value = "Work with Platform";
    form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await settle(element);
    await settle(element);

    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(element.textContent).toContain("Work with Platform");
  });

  it("refetches but never retries or claims success when the mutation outcome is unknown", async () => {
    let postCount = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = requestUrl(input);
      if (url.endsWith("/context")) {
        return json({ canReviewJoinRequests: false });
      }
      if (url.includes("/scopes?")) {
        return json({ items: [scopeResult()], hasMore: false });
      }
      if (url.includes("/requests/own") || url.includes("/requests/reviewable")) {
        return json({ items: [] });
      }
      if (url.endsWith("/requests") && init?.method === "POST") {
        postCount += 1;
        throw new TypeError("connection reset after commit");
      }
      throw new Error(`unexpected request ${url}`);
    });
    const element = document.createElement("platformclaw-organization-join-panel") as JoinPanel;
    element.fetchImpl = fetchImpl;
    document.body.append(element);
    await settle(element);
    element.querySelector<HTMLButtonElement>(".organization-request-list .primary")!.click();
    await settle(element);
    const form = element.querySelector<HTMLFormElement>(".organization-action-form")!;
    form.querySelector<HTMLTextAreaElement>("textarea")!.value = "Need access";
    form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await settle(element);
    await settle(element);

    expect(postCount).toBe(1);
    expect(element.textContent).toContain("platformClaw.organization.join.stateChanged");
    expect(element.textContent).not.toContain("platformClaw.organization.join.saved");
  });

  it("does not infer a page-two review decision from its absence on refreshed page one", async () => {
    let pageOneLoads = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = requestUrl(input);
      if (url.endsWith("/context")) {
        return json({ canReviewJoinRequests: true });
      }
      if (url.includes("/scopes?") || url.includes("/requests/own")) {
        return json(url.includes("/scopes?") ? { items: [], hasMore: false } : { items: [] });
      }
      if (url.includes("/requests/reviewable?offset=100")) {
        return json({ items: [reviewRequest("page-two")] });
      }
      if (url.includes("/requests/reviewable")) {
        pageOneLoads += 1;
        return json({ items: [reviewRequest("page-one")], nextOffset: 100 });
      }
      if (url.endsWith("/requests/page-two/decision") && init?.method === "POST") {
        throw new TypeError("connection reset before commit");
      }
      throw new Error(`unexpected request ${url}`);
    });
    const element = document.createElement("platformclaw-organization-join-panel") as JoinPanel;
    element.fetchImpl = fetchImpl;
    document.body.append(element);
    await settle(element);
    Object.assign(element, { section: "review" });
    element.requestUpdate();
    await settle(element);
    const more = [...element.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("platformClaw.organization.join.more"),
    );
    expect(more).toBeDefined();
    more!.click();
    await settle(element);
    const approveButtons = element.querySelectorAll<HTMLButtonElement>(
      ".organization-request-list .primary",
    );
    approveButtons.item(approveButtons.length - 1).click();
    await settle(element);
    const form = element.querySelector<HTMLFormElement>(".organization-action-form")!;
    form.querySelector<HTMLTextAreaElement>("textarea")!.value = "Verified";
    form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await settle(element);
    await settle(element);

    expect(pageOneLoads).toBeGreaterThan(1);
    expect(element.textContent).toContain("platformClaw.organization.join.stateChanged");
    expect(element.textContent).not.toContain("platformClaw.organization.join.saved");
  });

  it("reports an unconfirmed outcome when both the mutation and reconciliation fail", async () => {
    let afterMutation = false;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = requestUrl(input);
      if (url.endsWith("/context")) {
        if (afterMutation) {
          throw new TypeError("reload unavailable");
        }
        return json({ canReviewJoinRequests: false });
      }
      if (url.includes("/scopes?")) {
        return json({ items: [scopeResult()], hasMore: false });
      }
      if (url.includes("/requests/own")) {
        return json({ items: [] });
      }
      if (url.endsWith("/requests") && init?.method === "POST") {
        afterMutation = true;
        throw new TypeError("connection reset");
      }
      throw new Error(`unexpected request ${url}`);
    });
    const element = document.createElement("platformclaw-organization-join-panel") as JoinPanel;
    element.fetchImpl = fetchImpl;
    document.body.append(element);
    await settle(element);
    element.querySelector<HTMLButtonElement>(".organization-request-list .primary")!.click();
    await settle(element);
    const form = element.querySelector<HTMLFormElement>(".organization-action-form")!;
    form.querySelector<HTMLTextAreaElement>("textarea")!.value = "Need access";
    form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await settle(element);
    await settle(element);

    expect(element.textContent).toContain(
      "platformClaw.organization.join.outcomeUnknownReloadFailed",
    );
    expect(element.textContent).not.toContain("platformClaw.organization.savedReloadFailed");
    expect(element.querySelector("openclaw-modal-dialog")).toBeNull();
  });

  it.each(["request", "cancel", "approve"] as const)(
    "refreshes authoritative state without claiming a saved %s after conflict",
    async (kind) => {
      const ownItem = {
        request: {
          id: "request-1",
          scopeId: "team-1",
          reason: "Join Platform",
          status: "pending",
          createdAt: 10,
        },
        scope: scopeResult(),
        lineage: scopeResult().lineage,
      };
      const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
        const url = requestUrl(input);
        if (url.endsWith("/context")) {
          return json({ canReviewJoinRequests: kind === "approve" });
        }
        if (url.includes("/scopes?")) {
          return json({ items: [scopeResult()], hasMore: false });
        }
        if (url.includes("/requests/own")) {
          return json({ items: kind === "cancel" ? [ownItem] : [] });
        }
        if (url.includes("/requests/reviewable")) {
          return json({ items: kind === "approve" ? [reviewRequest("request-2")] : [] });
        }
        const mutation =
          (kind === "request" && url.endsWith("/requests")) ||
          (kind === "cancel" && url.endsWith("/requests/request-1/cancel")) ||
          (kind === "approve" && url.endsWith("/requests/request-2/decision"));
        if (mutation && init?.method === "POST") {
          return json({ code: "organization_join_request_terminal_conflict" }, 409);
        }
        throw new Error(`unexpected request ${url}`);
      });
      const element = document.createElement("platformclaw-organization-join-panel") as JoinPanel;
      element.fetchImpl = fetchImpl;
      document.body.append(element);
      await settle(element);
      Object.assign(element, {
        pending:
          kind === "request"
            ? { kind, id: "team-1", target: "Platform" }
            : kind === "cancel"
              ? { kind, id: "request-1", target: "Platform" }
              : { kind, id: "request-2", target: "Person / Platform" },
      });
      await element.submit("Confirmed reason");
      await settle(element);

      expect(element.textContent).toContain("platformClaw.organization.join.stateChanged");
      expect(element.textContent).not.toContain("platformClaw.organization.join.saved");
    },
  );

  it("shows the server-authorized review inbox and submits one decision", async () => {
    let decided = false;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = requestUrl(input);
      if (url.endsWith("/context")) {
        return json({ canReviewJoinRequests: true });
      }
      if (url.includes("/scopes?") || url.includes("/requests/own")) {
        return json(url.includes("/scopes?") ? { items: [], hasMore: false } : { items: [] });
      }
      if (url.includes("/requests/reviewable")) {
        return json({
          items: decided
            ? []
            : [
                {
                  request: {
                    id: "request-2",
                    scopeId: "team-1",
                    reason: "Join Platform",
                    status: "pending",
                    createdAt: 10,
                  },
                  applicant: { id: "user-2", accountId: "person.two", displayName: "Person Two" },
                  scope: scopeResult(),
                  lineage: scopeResult().lineage,
                },
              ],
        });
      }
      if (url.endsWith("/requests/request-2/decision") && init?.method === "POST") {
        decided = true;
        expect(requestBody(init)).toEqual({
          decision: "approved",
          reason: "Role confirmed",
        });
        return json({ id: "request-2", status: "approved" });
      }
      throw new Error(`unexpected request ${url}`);
    });
    const element = document.createElement("platformclaw-organization-join-panel") as JoinPanel;
    element.fetchImpl = fetchImpl;
    document.body.append(element);
    await settle(element);
    Object.assign(element, { section: "review" });
    element.requestUpdate();
    await settle(element);
    element.querySelector<HTMLButtonElement>(".organization-request-list .primary")!.click();
    await settle(element);
    const form = element.querySelector<HTMLFormElement>(".organization-action-form")!;
    form.querySelector<HTMLTextAreaElement>("textarea")!.value = "Role confirmed";
    form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await settle(element);
    await settle(element);

    expect(decided).toBe(true);
    expect(element.textContent).not.toContain("Join Platform");
  });
});
