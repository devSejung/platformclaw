/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import { buildMemoryTabContent } from "./memory-tab-content.ts";

type GatewaySnapshot = ApplicationContext["gateway"]["snapshot"];
type MemoriesElement = HTMLElement & {
  connected: boolean;
  connectionPhase: string;
  methodAdvertised: boolean | null;
  personalDetailAdvertised: boolean | null;
};

function renderMemories(snapshot: Partial<GatewaySnapshot>) {
  const container = document.createElement("div");
  document.body.append(container);
  render(
    buildMemoryTabContent(
      {
        client: null,
        hello: null,
        phase: "connecting",
        ...snapshot,
      } as GatewaySnapshot,
      "personal-agent",
    ).memories,
    container,
  );
  return container.querySelector("openclaw-memory-memories") as MemoriesElement;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("buildMemoryTabContent", () => {
  it("preserves connection and method discovery state for the shared Memory surface", () => {
    const loading = renderMemories({ phase: "reconnecting" });
    expect(loading.connected).toBe(false);
    expect(loading.connectionPhase).toBe("reconnecting");
    expect(loading.methodAdvertised).toBeNull();
    expect(loading.personalDetailAdvertised).toBeNull();

    const advertised = renderMemories({
      phase: "connected",
      hello: { features: { methods: ["memory.search"] } },
    } as Partial<GatewaySnapshot>);
    expect(advertised.connected).toBe(true);
    expect(advertised.methodAdvertised).toBe(true);
    expect(advertised.personalDetailAdvertised).toBe(false);

    const workspaceOnly = renderMemories({
      phase: "connected",
      hello: { features: { methods: ["agents.workspace.get"] } },
    } as Partial<GatewaySnapshot>);
    expect(workspaceOnly.methodAdvertised).toBe(false);
    expect(workspaceOnly.personalDetailAdvertised).toBe(true);
  });
});
