import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import { notifyPlatformClawExecutionTargetChanged } from "./execution-target-events.ts";
import { loadPlatformClawLocale } from "./i18n.ts";
import { PlatformClawQuickActionsElement } from "./quick-actions.ts";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

const BASIC_EXECUTION_SETTINGS = {
  activeTarget: "platform_server",
  targetRevision: 4,
  credentialStatus: "current",
  accountId: "person.one",
  availableVms: [],
  savedVms: [],
};

async function mount(
  options: {
    fetchImpl?: typeof fetch;
    vocEnabled?: boolean;
    locationOnly?: boolean;
    onUnauthenticated?: () => void;
  } = {},
) {
  const element = document.createElement(
    "platformclaw-quick-actions",
  ) as PlatformClawQuickActionsElement;
  element.fetchImpl =
    options.fetchImpl ?? vi.fn<typeof fetch>(async () => jsonResponse(BASIC_EXECUTION_SETTINGS));
  element.vocEnabled = options.vocEnabled ?? false;
  element.locationOnly = options.locationOnly ?? false;
  element.onUnauthenticated = options.onUnauthenticated ?? (() => {});
  document.body.append(element);
  await element.updateComplete;
  return element;
}

describe("platformclaw-quick-actions", () => {
  beforeEach(async () => {
    document.body.innerHTML = "";
    await i18n.setLocale("en");
    await loadPlatformClawLocale();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await i18n.setLocale("en");
  });

  it("shares the VOC row with the messenger link above personal work-location", async () => {
    const element = await mount({ vocEnabled: true });

    expect(element.shadowRoot?.querySelector('[aria-label="Guide"]')).toBeNull();
    expect(element.shadowRoot?.querySelector(".tour-popover")).toBeNull();
    expect(element.shadowRoot?.querySelector("platformclaw-vm-administration")).toBeNull();
    expect(
      element.shadowRoot?.querySelector("platformclaw-announcement-administration"),
    ).toBeNull();
    const items = [...(element.shadowRoot?.querySelector(".grid")?.children ?? [])];
    expect(items.map((item) => item.localName)).toEqual(["button", "a", "button"]);
    const messenger = element.shadowRoot?.querySelector<HTMLAnchorElement>("a.messenger");
    expect(messenger?.getAttribute("href")).toBe("mysingleim://sopa.ai");
    expect(messenger?.getAttribute("aria-label")).toBe("Knox");
    expect(messenger?.classList.contains("messenger--split")).toBe(true);

    element.shadowRoot?.querySelector<HTMLButtonElement>('[aria-label="VOC"]')?.click();
    await element.updateComplete;
    expect(element.shadowRoot?.querySelector("platformclaw-voc-dialog")).not.toBeNull();
  });

  it("uses the PlatformClaw-owned Korean work-location copy", async () => {
    await i18n.setLocale("ko");
    await loadPlatformClawLocale();
    const member = await mount();

    await vi.waitFor(() => expect(member.shadowRoot?.textContent).toContain("작업 위치"));
    expect(member.shadowRoot?.textContent).not.toContain("가이드");
    const messenger = member.shadowRoot?.querySelector<HTMLAnchorElement>("a.messenger");
    expect(messenger?.getAttribute("aria-label")).toBe("Knox");
    expect(messenger?.classList.contains("span-two")).toBe(true);
  });

  it("opens the existing execution settings control", async () => {
    const member = await mount();
    member.shadowRoot?.querySelector<HTMLButtonElement>('[data-action="work-location"]')?.click();

    await vi.waitFor(() =>
      expect(member.shadowRoot?.querySelector("platformclaw-execution-settings")).not.toBeNull(),
    );
  });

  it.each([
    {
      target: "platform_server",
      status: undefined,
      credential: "missing",
      label: "Basic server",
      state: "ready",
    },
    {
      target: "assigned_vm",
      status: "ready",
      credential: "current",
      label: "Development VM",
      state: "ready",
    },
    {
      target: "assigned_vm",
      status: "connection_required",
      credential: "current",
      label: "Development VM",
      state: "warning",
    },
    {
      target: "assigned_vm",
      status: "ready",
      credential: "update_required",
      label: "Development VM",
      state: "warning",
    },
  ])("shows the selected $target/$status profile without changing it", async (scenario) => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        ...BASIC_EXECUTION_SETTINGS,
        activeTarget: scenario.target,
        credentialStatus: scenario.credential,
        ...(scenario.status ? { assignment: { status: scenario.status } } : {}),
      }),
    );
    const element = await mount({ locationOnly: true, fetchImpl });

    await vi.waitFor(() => {
      const indicator = element.shadowRoot?.querySelector('[role="status"]');
      expect(indicator?.getAttribute("data-state")).toBe(scenario.state);
      expect(indicator?.getAttribute("aria-label")).toContain(
        `Selected location: ${scenario.label}`,
      );
    });
    expect(
      element.shadowRoot?.querySelector("button, a, platformclaw-execution-settings"),
    ).toBeNull();
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith("/platformclaw/api/execution", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
  });

  it("refreshes on target changes and ignores an older profile response", async () => {
    let resolveOld!: (response: Response) => void;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          ...BASIC_EXECUTION_SETTINGS,
          activeTarget: "assigned_vm",
          assignment: { status: "ready" },
        }),
      );
    const element = await mount({ locationOnly: true, fetchImpl });
    expect(element.shadowRoot?.querySelector('[role="status"]')?.getAttribute("data-state")).toBe(
      "loading",
    );
    notifyPlatformClawExecutionTargetChanged();
    await vi.waitFor(() =>
      expect(element.shadowRoot?.textContent).toContain("Selected location: Development VM"),
    );
    resolveOld(jsonResponse(BASIC_EXECUTION_SETTINGS));
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    await element.updateComplete;
    expect(element.shadowRoot?.textContent).not.toContain("Basic server");
  });

  it("clears a previous target when the refresh fails and unsubscribes when removed", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(BASIC_EXECUTION_SETTINGS))
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    const element = await mount({ locationOnly: true, fetchImpl });
    await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain("Basic server"));
    notifyPlatformClawExecutionTargetChanged();
    await vi.waitFor(() =>
      expect(element.shadowRoot?.querySelector('[role="status"]')?.getAttribute("data-state")).toBe(
        "unavailable",
      ),
    );
    expect(element.shadowRoot?.textContent).not.toContain("Basic server");
    element.remove();
    notifyPlatformClawExecutionTargetChanged();
    window.dispatchEvent(new Event("focus"));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("refreshes the named VM in the header after a direct VM-to-VM change", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    for (const vmLabel of ["Research VM", "Build VM"]) {
      fetchImpl.mockResolvedValueOnce(
        jsonResponse({
          ...BASIC_EXECUTION_SETTINGS,
          activeTarget: "assigned_vm",
          assignment: { status: "ready", vmLabel },
        }),
      );
    }
    const element = await mount({ locationOnly: true, fetchImpl });
    const expectLocation = async (label: string) => {
      await vi.waitFor(() => {
        const indicator = element.shadowRoot?.querySelector('[role="status"]');
        expect(indicator?.textContent?.trim()).toBe(label);
        expect(indicator?.getAttribute("aria-label")).toBe(label);
        expect(indicator?.getAttribute("title")).toContain(label);
      });
    };
    await expectLocation("Selected location: Research VM");
    notifyPlatformClawExecutionTargetChanged();
    await expectLocation("Selected location: Build VM");
    expect(element.shadowRoot?.textContent).not.toContain("Research VM");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await i18n.setLocale("ko");
    await loadPlatformClawLocale();
    await expectLocation("선택 위치: Build VM");
  });

  it("revalidates the selected profile when returning from another window", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(BASIC_EXECUTION_SETTINGS))
      .mockResolvedValueOnce(
        jsonResponse({
          ...BASIC_EXECUTION_SETTINGS,
          activeTarget: "assigned_vm",
          assignment: { status: "ready" },
        }),
      );
    const element = await mount({ locationOnly: true, fetchImpl });
    await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain("Basic server"));
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() =>
      expect(element.shadowRoot?.textContent).toContain("Selected location: Development VM"),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("uses the existing session-expiry handler without presenting a fallback target", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 401 }));
    const onUnauthenticated = vi.fn();
    const element = await mount({ locationOnly: true, fetchImpl, onUnauthenticated });
    await vi.waitFor(() => expect(onUnauthenticated).toHaveBeenCalledOnce());
    expect(element.shadowRoot?.textContent).not.toContain("Basic server");
  });
});
