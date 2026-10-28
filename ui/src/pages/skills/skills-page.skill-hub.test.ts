/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import { loadPlatformClawLocale } from "../../platformclaw/i18n.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  skillHubConfig,
  skillHubJson,
  skillHubRequestUrl,
} from "../skill-hub/skill-hub.test-fixtures.ts";
import type { SkillsRouteData } from "./skills-page.ts";
import { createProps, createSkill } from "./view.test-helpers.ts";
import "./skills-page.ts";

type TestSkillsPage = HTMLElement & {
  routeData: SkillsRouteData;
  updateComplete: Promise<boolean>;
};

function findButton(root: ParentNode, label: string): HTMLButtonElement | undefined {
  return [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === label,
  );
}

function mountPage(target: "platform_server" | "assigned_vm", hubEnabled = true) {
  const props = createProps();
  const report = {
    ...props.report!,
    executionTarget: target,
    skills: [
      createSkill({
        source: target === "assigned_vm" ? "platformclaw-vm-workspace" : "openclaw-workspace",
        skillKey: "demo",
      }),
    ],
  };
  const request = vi.fn(async () => report);
  const client = { request } as unknown as GatewayBrowserClient;
  const snapshot = {
    phase: "connected",
    client,
    hello: { auth: { role: "operator", scopes: ["operator.read"] } },
  } as ApplicationGatewaySnapshot;
  const gateway = {
    snapshot,
    subscribe: () => () => undefined,
    subscribeEvents: () => () => undefined,
  } as unknown as ApplicationContext["gateway"];
  const agents = {
    state: {
      client,
      connected: true,
      agentsLoading: false,
      agentsError: null,
      agentsList: props.agentsList,
    },
    ensureList: vi.fn(async () => props.agentsList),
    subscribe: () => () => undefined,
  } as unknown as ApplicationContext["agents"];
  const provider = createApplicationContextProvider({
    basePath: "",
    accessMode: "personal-agent",
    gateway,
    agents,
    isRouteEnabled: () => hubEnabled,
    navigate: vi.fn(),
  } as unknown as ApplicationContext);
  const page = document.createElement("openclaw-skills-page") as TestSkillsPage;
  page.routeData = {
    gateway,
    gatewaySnapshot: snapshot,
    agents,
    agentsList: props.agentsList,
    selectedAgentId: "main",
    report,
    error: null,
  };
  provider.append(page);
  document.body.append(provider);
  return { page, request };
}

describe("Skills workspace Hub settings recovery", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
    await loadPlatformClawLocale();
  });
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it.each(["platform_server", "assigned_vm"] as const)(
    "explains a settings failure and retries through Refresh for a prefetched %s workspace",
    async (target) => {
      let configReads = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (request: RequestInfo | URL) => {
          const url = skillHubRequestUrl(request);
          if (url.endsWith("/config")) {
            configReads += 1;
            return configReads === 1
              ? skillHubJson({ error: "Sharing settings unavailable" }, 503)
              : skillHubJson(skillHubConfig({ activeTarget: target }));
          }
          return skillHubJson({ source: target, items: [{ skillKey: "demo" }] });
        }),
      );
      const { page, request } = mountPage(target);
      await waitForFast(() => {
        const failure = page.querySelector('.callout.danger[role="alert"]');
        expect(failure?.textContent).toContain("Sharing settings unavailable");
        expect(failure?.textContent).toContain("Select Refresh to try again");
      });
      expect(configReads).toBe(1);
      expect(findButton(page, "Publish to Hub")).toBeUndefined();
      expect(request).not.toHaveBeenCalled();
      findButton(page, "Refresh")!.click();
      await waitForFast(() => expect(findButton(page, "Publish to Hub")?.disabled).toBe(false));
      expect(configReads).toBe(2);
      expect(request).toHaveBeenCalledWith("skills.status", { agentId: "main", refresh: true });
      expect(page.querySelector('.callout.danger[role="alert"]')).toBeNull();
      findButton(page, "Publish to Hub")!.click();
      await waitForFast(() =>
        expect(page.querySelector<HTMLSelectElement>('[name="source"]')?.value).toBe(target),
      );
      expect(page.querySelector<HTMLSelectElement>('[name="sharing"]')?.value).toBe("PUBLIC");
    },
  );

  it("keeps the Hub disabled by route policy during initial load and manual refresh", async () => {
    const fetch = vi.fn(async () => skillHubJson(skillHubConfig()));
    vi.stubGlobal("fetch", fetch);
    const { page, request } = mountPage("platform_server", false);
    await page.updateComplete;
    expect(fetch).not.toHaveBeenCalled();
    expect(findButton(page, "Publish to Hub")).toBeUndefined();
    findButton(page, "Refresh")!.click();
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());
    await page.updateComplete;
    expect(fetch).not.toHaveBeenCalled();
    expect(findButton(page, "Publish to Hub")).toBeUndefined();
  });

  it("preserves a committed publication outcome while Refresh recovers its settings", async () => {
    let configReads = 0;
    let publications = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: RequestInfo | URL) => {
        const url = skillHubRequestUrl(request);
        if (url.endsWith("/config")) {
          configReads += 1;
          return configReads === 2
            ? skillHubJson({ error: "Settings refresh unavailable" }, 503)
            : skillHubJson(skillHubConfig());
        }
        if (url.endsWith("/publish")) {
          publications += 1;
          return skillHubJson({ id: "entry-one", slug: "demo", version: "1.0.0" });
        }
        return skillHubJson({ source: "platform_server", items: [{ skillKey: "demo" }] });
      }),
    );
    const { page } = mountPage("platform_server");
    await waitForFast(() => expect(findButton(page, "Publish to Hub")).toBeDefined());
    findButton(page, "Publish to Hub")!.click();
    await waitForFast(() =>
      expect(page.querySelector<HTMLSelectElement>('[name="skill"]')?.value).toBe("demo"),
    );
    findButton(page.querySelector(".skill-hub-workspace-publish")!, "Publish")!.click();
    await waitForFast(() =>
      expect(page.querySelector('.callout.warning[role="status"]')?.textContent).toContain(
        "Published demo@1.0.0 from Basic workspace.",
      ),
    );
    expect(page.querySelector('.callout.warning[role="status"]')?.textContent).toContain(
      "Settings refresh unavailable",
    );
    findButton(page, "Refresh")!.click();
    await waitForFast(() => expect(configReads).toBe(3));
    await page.updateComplete;
    expect(page.querySelector('.callout.warning[role="status"]')?.textContent).toContain(
      "Published demo@1.0.0 from Basic workspace.",
    );
    expect(publications).toBe(1);
  });
});
