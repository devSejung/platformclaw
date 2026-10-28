/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  skillHubConfig,
  skillHubDetail,
  skillHubEntry,
  skillHubJson,
  skillHubRequestBody,
  skillHubRequestUrl,
} from "./skill-hub.test-fixtures.ts";
import "./skill-hub-page.ts";

function button(root: ParentNode, text: string): HTMLButtonElement {
  const result = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.trim() === text,
  );
  if (!result) {
    throw new Error(`Missing button: ${text}`);
  }
  return result;
}

function field(root: ParentNode, name: string, value: string, event = "input") {
  const input = root.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
  input.value = value;
  input.dispatchEvent(new Event(event, { bubbles: true }));
}

async function mount() {
  const page = document.createElement("openclaw-skill-hub-page");
  document.body.append(page);
  await waitForFast(() => expect(button(page, "Publish workspace skill").disabled).toBe(false));
  return page;
}

describe("Skill Hub displayed workspace identity", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    window.history.replaceState({}, "", window.location.pathname);
  });

  it("pins publication to the displayed VM, reloads without losing the draft, and recovers its original ID after reactivation", async () => {
    let activeId = "vm-one";
    let targetRevision = 1;
    const requests: Array<Record<string, unknown>> = [];
    const effects: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = skillHubRequestUrl(input);
        if (url.endsWith("/config")) {
          return skillHubJson(skillHubConfig({ activeTarget: "assigned_vm" }));
        }
        if (url.includes("/workspace-skills")) {
          return skillHubJson({
            source: "assigned_vm",
            targetId: activeId,
            targetRevision,
            targetLabel: activeId === "vm-one" ? "Build VM one" : "Build VM two",
            items: [{ skillKey: "demo", version: "3.0.0", revision: "unchanged-files" }],
          });
        }
        if (url.endsWith("/publish")) {
          const body = JSON.parse(skillHubRequestBody(init?.body)) as Record<string, unknown>;
          requests.push(body);
          if (body.expectedTargetId !== undefined && body.expectedTargetId !== activeId) {
            return skillHubJson(
              { error: "Execution target changed", details: { code: "skill-hub-changed" } },
              409,
            );
          }
          effects.push(activeId);
          return skillHubJson({ id: activeId, slug: "demo", version: body.version });
        }
        return skillHubJson({ items: [], total: 0 });
      }),
    );
    const page = await mount();
    button(page, "Publish workspace skill").click();
    const dialog = () => page.querySelector(".skill-hub-workspace-publish")!;
    await waitForFast(() => expect(dialog().textContent).toContain("Build VM one"));
    field(dialog(), "version", "7.0.0");
    field(dialog(), "sharing", "PRIVATE", "change");
    activeId = "vm-two";
    targetRevision = 2;
    button(dialog(), "Publish").click();
    await waitForFast(() =>
      expect(button(dialog(), "Restore original request").disabled).toBe(false),
    );
    expect(requests[0]).toMatchObject({
      source: "assigned_vm",
      expectedTargetId: "vm-one",
      version: "7.0.0",
    });
    expect(requests[0]).not.toHaveProperty("expectedTargetRevision");
    expect(effects).toEqual([]);
    button(dialog(), "Reload workspace skills").click();
    await waitForFast(() =>
      expect(dialog().querySelector(".skill-hub-target-label")?.textContent).toBe("Build VM two"),
    );
    expect(dialog().querySelector<HTMLInputElement>('[name="version"]')?.value).toBe("7.0.0");
    expect(dialog().querySelector<HTMLSelectElement>('[name="sharing"]')?.value).toBe("PRIVATE");
    expect(dialog().querySelector<HTMLSelectElement>('[name="skill"]')?.value).toBe("demo");
    button(dialog(), "Publish").click();
    await waitForFast(() => expect(page.querySelector(".skill-hub-workspace-publish")).toBeNull());
    expect(requests[1]).toMatchObject({
      expectedTargetId: "vm-two",
      version: "7.0.0",
      sharing: { mode: "PRIVATE", userIds: [], scopeIds: [] },
    });
    expect(requests[1]!.operationId).not.toBe(requests[0]!.operationId);
    activeId = "vm-one";
    targetRevision = 99;
    button(page, "Publish workspace skill").click();
    await waitForFast(() =>
      expect(button(dialog(), "Restore original request").disabled).toBe(false),
    );
    button(dialog(), "Restore original request").click();
    await waitForFast(() =>
      expect(dialog().querySelector<HTMLInputElement>('[name="version"]')?.value).toBe("7.0.0"),
    );
    button(dialog(), "Publish").click();
    await waitForFast(() => expect(requests).toHaveLength(3));
    expect(requests[2]).toEqual(requests[0]);
    expect(effects).toEqual(["vm-two", "vm-one"]);
  });

  it("pins installation to the inspected VM and keeps Basic independent of VM selection revisions", async () => {
    const entry = skillHubEntry();
    let activeId = "vm-one";
    let targetRevision = 1;
    const requests: Array<Record<string, unknown>> = [];
    const effects: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = skillHubRequestUrl(input);
        if (url.endsWith("/config")) {
          return skillHubJson(skillHubConfig());
        }
        if (url.includes("/search?")) {
          return skillHubJson({ items: [entry], total: 1 });
        }
        if (url.includes("/workspace-skills")) {
          const source = new URL(url, "http://localhost").searchParams.get("source");
          return skillHubJson({
            source,
            targetId: source === "assigned_vm" ? activeId : "platform-server",
            targetRevision,
            targetLabel: source === "assigned_vm" ? activeId : undefined,
            items: [],
          });
        }
        if (url.endsWith("/install")) {
          const body = JSON.parse(skillHubRequestBody(init?.body)) as Record<string, unknown>;
          requests.push(body);
          const expected = body.destination === "assigned_vm" ? activeId : "platform-server";
          if (body.expectedTargetId !== undefined && body.expectedTargetId !== expected) {
            return skillHubJson(
              { error: "Execution target changed", details: { code: "skill-hub-changed" } },
              409,
            );
          }
          effects.push(expected);
          return skillHubJson({
            ok: true,
            slug: entry.slug,
            version: body.version,
            target: body.destination,
          });
        }
        return skillHubJson(skillHubDetail({ skill: entry }));
      }),
    );
    const page = await mount();
    page.querySelector<HTMLButtonElement>(".skill-hub-card")!.click();
    const vm = () => page.querySelector('[data-install-target="assigned_vm"]')!;
    const basic = () => page.querySelector('[data-install-target="platform_server"]')!;
    await waitForFast(() => expect(vm().querySelector("h4")?.textContent).toContain("vm-one"));
    activeId = "vm-two";
    targetRevision = 2;
    vm().querySelector<HTMLButtonElement>("button")!.click();
    await waitForFast(() => expect(vm().querySelector("h4")?.textContent).toContain("vm-two"));
    await waitForFast(() =>
      expect(vm().querySelector<HTMLButtonElement>("button")!.disabled).toBe(false),
    );
    expect(requests[0]).toMatchObject({
      destination: "assigned_vm",
      expectedTargetId: "vm-one",
      expectedTargetRevision: 1,
    });
    expect(effects).toEqual([]);
    vm().querySelector<HTMLButtonElement>("button")!.click();
    await waitForFast(() => expect(effects).toEqual(["vm-two"]));
    await waitForFast(() =>
      expect(basic().querySelector<HTMLButtonElement>("button")!.disabled).toBe(false),
    );
    targetRevision = 3;
    basic().querySelector<HTMLButtonElement>("button")!.click();
    await waitForFast(() => expect(effects).toEqual(["vm-two", "platform-server"]));
    expect(requests[2]).toMatchObject({
      destination: "platform_server",
      expectedTargetId: "platform-server",
    });
    expect(requests[2]).not.toHaveProperty("expectedTargetRevision");
  });

  it("keeps replacement confirmation bound to the VM that was inspected", async () => {
    const entry = skillHubEntry();
    let activeId = "vm-one";
    let targetRevision = 1;
    const requests: Array<Record<string, unknown>> = [];
    let effects = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = skillHubRequestUrl(input);
        if (url.endsWith("/config")) {
          return skillHubJson(skillHubConfig());
        }
        if (url.includes("/search?")) {
          return skillHubJson({ items: [entry], total: 1 });
        }
        if (url.includes("/workspace-skills")) {
          const source = new URL(url, "http://localhost").searchParams.get("source");
          return skillHubJson({
            source,
            targetId: source === "assigned_vm" ? activeId : "platform-server",
            targetRevision,
            targetLabel: activeId,
            items:
              source === "assigned_vm"
                ? [
                    {
                      skillKey: entry.slug,
                      version: "0.5.0",
                      revision: "old-files",
                      hubSkillId: entry.id,
                    },
                  ]
                : [],
          });
        }
        if (url.endsWith("/install")) {
          const body = JSON.parse(skillHubRequestBody(init?.body)) as Record<string, unknown>;
          requests.push(body);
          if (body.expectedTargetId !== undefined && body.expectedTargetId !== activeId) {
            return skillHubJson(
              { error: "Execution target changed", details: { code: "skill-hub-changed" } },
              409,
            );
          }
          if (!body.acknowledgedReplacement) {
            return skillHubJson(
              {
                error: "Confirm replacement",
                details: {
                  code: "existing-skill-replacement-required",
                  currentVersion: "0.5.0",
                  currentRevision: "old-files",
                  requestedVersion: "1.0.0",
                  direction: "upgrade",
                },
              },
              409,
            );
          }
          effects += 1;
          return skillHubJson({
            ok: true,
            slug: entry.slug,
            version: "1.0.0",
            target: "assigned_vm",
          });
        }
        return skillHubJson(skillHubDetail({ skill: entry }));
      }),
    );
    const page = await mount();
    page.querySelector<HTMLButtonElement>(".skill-hub-card")!.click();
    const vm = () => page.querySelector('[data-install-target="assigned_vm"]')!;
    await waitForFast(() =>
      expect(vm().querySelector<HTMLButtonElement>("button")!.disabled).toBe(false),
    );
    vm().querySelector<HTMLButtonElement>("button")!.click();
    await waitForFast(() =>
      expect(page.querySelector(".skill-hub-version-change")?.textContent).toContain("vm-one"),
    );
    activeId = "vm-two";
    targetRevision = 2;
    button(page.querySelector(".skill-hub-version-change")!, "Replace installed version").click();
    await waitForFast(() => expect(requests).toHaveLength(2));
    expect(requests[1]).toMatchObject({
      expectedTargetId: "vm-one",
      expectedTargetRevision: 1,
      acknowledgedReplacement: true,
      currentRevision: "old-files",
    });
    expect(effects).toBe(0);
    await waitForFast(() => expect(vm().querySelector("h4")?.textContent).toContain("vm-two"));
    expect(page.querySelector(".skill-hub-version-change")).toBeNull();
  });

  it("can recheck an already installed VM without duplicate reads or an unintended install", async () => {
    const entry = skillHubEntry();
    let activeId = "vm-one";
    let vmReads = 0;
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = skillHubRequestUrl(input);
        if (url.endsWith("/config")) {
          return skillHubJson(skillHubConfig());
        }
        if (url.includes("/search?")) {
          return skillHubJson({ items: [entry], total: 1 });
        }
        if (url.includes("/workspace-skills")) {
          const source = new URL(url, "http://localhost").searchParams.get("source");
          if (source === "assigned_vm") {
            vmReads += 1;
          }
          return skillHubJson({
            source,
            targetId: source === "assigned_vm" ? activeId : "platform-server",
            targetRevision: 2,
            targetLabel: activeId,
            items:
              source === "assigned_vm" && activeId === "vm-one"
                ? [{ skillKey: entry.slug, version: "1.0.0", hubSkillId: entry.id }]
                : [],
          });
        }
        if (url.endsWith("/install")) {
          requests.push(JSON.parse(skillHubRequestBody(init?.body)));
          return skillHubJson({
            ok: true,
            slug: entry.slug,
            version: "1.0.0",
            target: "assigned_vm",
          });
        }
        return skillHubJson(skillHubDetail({ skill: entry }));
      }),
    );
    const page = await mount();
    page.querySelector<HTMLButtonElement>(".skill-hub-card")!.click();
    const vm = () => page.querySelector('[data-install-target="assigned_vm"]')!;
    await waitForFast(() => expect(vm().querySelector("h4")?.textContent).toContain("vm-one"));
    expect(vm().querySelector<HTMLButtonElement>("button")!.disabled).toBe(true);
    activeId = "vm-two";
    const recheck = button(vm(), "Check again");
    recheck.click();
    recheck.click();
    await waitForFast(() => expect(vm().querySelector("h4")?.textContent).toContain("vm-two"));
    expect(vmReads).toBe(2);
    expect(requests).toEqual([]);
    await waitForFast(() =>
      expect(vm().querySelector<HTMLButtonElement>("button")!.disabled).toBe(false),
    );
    vm().querySelector<HTMLButtonElement>("button")!.click();
    await waitForFast(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({ expectedTargetId: "vm-two", expectedTargetRevision: 2 });
  });
});
