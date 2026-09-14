import { describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createGateway, createSessionsHarness, mountSidebar } from "../app-sidebar.ts";
import "../../components/app-sidebar.ts";

describe("AppSidebar child-session lineage", () => {
  it("keeps a selected child reachable when its parent is outside the loaded window", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const harness = createSessionsHarness("main", ["agent:main:child"]);
    const { sidebar } = await mountSidebar(gateway, harness.sessions);
    harness.publishList({
      result: {
        ts: 2,
        path: "",
        count: 1,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [
          {
            key: "agent:main:child",
            spawnedBy: "agent:main:missing-parent",
            kind: "direct",
            label: "Reachable orphan",
            updatedAt: 2,
            status: "done",
          },
        ],
      },
    });
    (sidebar as unknown as { activeRouteId: string }).activeRouteId = "chat";
    sidebar.sessionKey = "agent:main:child";
    await sidebar.updateComplete;

    const row = sidebar.querySelector('[data-session-key="agent:main:child"]');
    expect(row?.textContent).toContain("Reachable orphan");
    expect(row?.classList.contains("sidebar-recent-session--child")).toBe(false);
  });
});
