/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import "./memory-organization.ts";

type OrganizationElement = HTMLElement & {
  client: GatewayBrowserClient | null;
  connected: boolean;
  lifecycleAdvertised: boolean;
  graphAdvertised: boolean;
  wikiSearchAdvertised: boolean;
  wikiGetAdvertised: boolean;
  organizationGetAdvertised: boolean;
  knowledgeAdvertised: boolean;
  agentId: string | null;
  updateComplete: Promise<unknown>;
};

afterEach(() => {
  document.body.innerHTML = "";
});

describe("PlatformClawMemoryOrganization", () => {
  it("shows management only for canonical eligible scopes and clears it on actor change", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        scopes: [{ capabilities: { canReadReport: true, canReviewProposals: false } }],
        selected: null,
        scopesHasMore: false,
      })
      .mockResolvedValueOnce({ scopes: [], selected: null, scopesHasMore: false });
    const element = document.createElement(
      "platformclaw-memory-organization",
    ) as OrganizationElement;
    element.client = { request } as unknown as GatewayBrowserClient;
    element.connected = true;
    element.knowledgeAdvertised = true;
    element.agentId = "leader-a";
    document.body.append(element);
    await waitForFast(() =>
      expect(
        element.querySelector("#platformclaw-memory-organization-tab-knowledge"),
      ).not.toBeNull(),
    );
    element.agentId = "unrelated-d";
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    expect(element.querySelector("#platformclaw-memory-organization-tab-knowledge")).toBeNull();
    expect(element.querySelector("openclaw-memory-promotions")).not.toBeNull();
    expect(
      request.mock.calls.every((call) => call[0] === "platformclaw.memory.knowledge.snapshot"),
    ).toBe(true);
  });
  it("keeps Sharing as the default and lazy-loads the separate Organization Graph", async () => {
    const request = vi.fn(async (method: string) =>
      method === "platformclaw.memory.lifecycle"
        ? {
            scopes: [
              {
                kind: "part",
                id: "part-runtime",
                name: "Runtime",
                canRead: true,
                canAdminister: false,
              },
            ],
            personalTargets: [],
            claims: [],
            submitted: [],
            reviewable: [],
            canApproveGlobal: false,
          }
        : {
            kind: "part",
            nodes: [],
            edges: [],
            stats: {
              totalPages: 0,
              totalNodes: 0,
              totalEdges: 0,
              truncated: false,
              partial: false,
            },
          },
    );
    const element = document.createElement(
      "platformclaw-memory-organization",
    ) as OrganizationElement;
    element.client = { request } as unknown as GatewayBrowserClient;
    element.connected = true;
    element.lifecycleAdvertised = true;
    element.graphAdvertised = true;
    element.wikiSearchAdvertised = true;
    element.wikiGetAdvertised = true;
    element.organizationGetAdvertised = true;
    element.agentId = "personal-agent";
    document.body.append(element);

    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("platformclaw.memory.lifecycle", {}),
    );
    expect(element.querySelector("openclaw-memory-promotions")).not.toBeNull();
    expect(element.querySelector("platformclaw-organization-memory-graph")).toBeNull();
    expect(request).not.toHaveBeenCalledWith("platformclaw.memory.graph", expect.anything());

    element
      .querySelector("#platformclaw-memory-organization-tab-graph")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("platformclaw.memory.graph", {
        kind: "part",
        scopeId: "part-runtime",
      }),
    );
    expect(element.querySelector("openclaw-memory-promotions")).toBeNull();
    expect(element.querySelector("platformclaw-organization-memory-graph")).not.toBeNull();
  });
});
