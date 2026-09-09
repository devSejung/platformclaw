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
  agentId: string | null;
  updateComplete: Promise<unknown>;
};

afterEach(() => {
  document.body.innerHTML = "";
});

describe("PlatformClawMemoryOrganization", () => {
  it("keeps Sharing as the default and lazy-loads the separate Organization Graph", async () => {
    const request = vi.fn(async (method: string) =>
      method === "platformclaw.memory.lifecycle"
        ? {
            scopes: [],
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
      expect(request).toHaveBeenCalledWith("platformclaw.memory.graph", { kind: "part" }),
    );
    expect(element.querySelector("openclaw-memory-promotions")).toBeNull();
    expect(element.querySelector("platformclaw-organization-memory-graph")).not.toBeNull();
  });
});
