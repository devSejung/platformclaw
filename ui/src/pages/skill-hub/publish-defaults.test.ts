/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { skillHubRequestBody, skillHubRequestUrl } from "./skill-hub.test-fixtures.ts";
import { skillHubConfig, skillHubJson } from "./skill-hub.test-fixtures.ts";
import "./skill-hub-page.ts";

const findButton = (root: ParentNode, label: string) =>
  [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === label,
  )!;

describe("Skill Hub publication defaults", () => {
  it("publishes a new version only to the explicitly selected ID and preserves its sharing", async () => {
    const id = "33333333-3333-4333-8333-333333333333";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = skillHubRequestUrl(input);
      if (url.endsWith("/config")) {
        return skillHubJson(
          skillHubConfig({
            ownedSkills: [{ id, slug: "demo", displayName: "My existing skill", revision: 42 }],
          }),
        );
      }
      if (url.includes("/workspace-skills")) {
        return skillHubJson({ source: "platform_server", items: [{ skillKey: "demo" }] });
      }
      if (url.endsWith("/publish")) {
        return skillHubJson({ id, slug: "demo", version: "2.0.0" });
      }
      return skillHubJson({ items: [], total: 0 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const page = document.createElement("openclaw-skill-hub-page");
    document.body.append(page);
    await waitForFast(() =>
      expect(findButton(page, "Publish workspace skill").disabled).toBe(false),
    );
    findButton(page, "Publish workspace skill").click();
    await waitForFast(() =>
      expect(page.querySelector<HTMLSelectElement>('[name="skill"]')?.value).toBe("demo"),
    );
    const existing = page.querySelector<HTMLSelectElement>('[name="existingId"]')!;
    existing.value = id;
    existing.dispatchEvent(new Event("change", { bubbles: true }));
    await waitForFast(() => expect(page.querySelector('[name="sharing"]')).toBeNull());
    const version = page.querySelector<HTMLInputElement>('[name="version"]')!;
    version.value = "2.0.0";
    version.dispatchEvent(new Event("input", { bubbles: true }));
    findButton(page.querySelector(".skill-hub-workspace-publish")!, "Publish").click();
    await waitForFast(() =>
      expect(
        fetchMock.mock.calls.some(([url]) => skillHubRequestUrl(url).endsWith("/publish")),
      ).toBe(true),
    );
    const call = fetchMock.mock.calls.find(([url]) =>
      skillHubRequestUrl(url).endsWith("/publish"),
    )!;
    const body = JSON.parse(skillHubRequestBody(call[1]?.body));
    expect(body).toMatchObject({
      id,
      expectedRevision: 42,
      version: "2.0.0",
      source: "platform_server",
    });
    expect(body).not.toHaveProperty("sharing");
  });
  beforeEach(async () => {
    await i18n.setLocale("en");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
    window.history.replaceState({}, "", window.location.pathname);
  });

  it.each(["platform_server", "assigned_vm"] as const)(
    "publishes from %s as company-wide without requiring organization setup",
    async (source) => {
      const config = skillHubConfig({ activeTarget: source });
      const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = skillHubRequestUrl(input);
        if (url.endsWith("/config")) {
          return skillHubJson(config);
        }
        if (url.includes("/workspace-skills")) {
          return skillHubJson({
            source: new URL(url, "http://localhost").searchParams.get("source"),
            items: [{ skillKey: "demo" }],
          });
        }
        if (url.endsWith("/publish")) {
          return skillHubJson({ id: "entry-one", slug: "demo", version: "1.0.0" });
        }
        return skillHubJson({ items: [], total: 0 });
      });
      vi.stubGlobal("fetch", fetchMock);
      const page = document.createElement("openclaw-skill-hub-page");
      document.body.append(page);
      await waitForFast(() =>
        expect(findButton(page, "Publish workspace skill").disabled).toBe(false),
      );
      findButton(page, "Publish workspace skill").click();
      await waitForFast(() =>
        expect(page.querySelector<HTMLSelectElement>('[name="skill"]')?.value).toBe("demo"),
      );
      expect(page.querySelector<HTMLSelectElement>('[name="source"]')?.value).toBe(source);
      expect(page.querySelector<HTMLSelectElement>('[name="sharing"]')?.value).toBe("PUBLIC");
      expect(page.querySelector('[name="namespace"]')).toBeNull();
      findButton(page.querySelector(".skill-hub-workspace-publish")!, "Publish").click();
      await waitForFast(() =>
        expect(
          fetchMock.mock.calls.some(([url]) => skillHubRequestUrl(url).endsWith("/publish")),
        ).toBe(true),
      );
      const call = fetchMock.mock.calls.find(([url]) =>
        skillHubRequestUrl(url).endsWith("/publish"),
      )!;
      expect(JSON.parse(skillHubRequestBody(call[1]?.body))).toMatchObject({
        source,
        skill: "demo",
        sharing: { mode: "PUBLIC", userIds: [], scopeIds: [] },
      });
      expect(JSON.parse(skillHubRequestBody(call[1]?.body))).not.toHaveProperty("namespace");
    },
  );

  it("preserves an unchanged retry ID and creates a new one after selecting another skill", async () => {
    const bodies: Array<{ operationId: string; skill: string; version: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = skillHubRequestUrl(input);
        if (url.endsWith("/config")) {
          return skillHubJson(skillHubConfig());
        }
        if (url.includes("/workspace-skills")) {
          return skillHubJson({
            source: "platform_server",
            items: [
              { skillKey: "first", version: "1.0.0" },
              { skillKey: "second", version: "2.0.0" },
            ],
          });
        }
        if (url.endsWith("/publish")) {
          bodies.push(JSON.parse(skillHubRequestBody(init?.body)));
          return skillHubJson({ error: "Publication pending" }, 503);
        }
        return skillHubJson({ items: [], total: 0 });
      }),
    );
    const page = document.createElement("openclaw-skill-hub-page");
    document.body.append(page);
    await waitForFast(() =>
      expect(findButton(page, "Publish workspace skill").disabled).toBe(false),
    );
    findButton(page, "Publish workspace skill").click();
    await waitForFast(() =>
      expect(
        page.querySelector<HTMLSelectElement>('[name="skill"]')?.options.length,
      ).toBeGreaterThan(2),
    );
    const select = page.querySelector<HTMLSelectElement>('[name="skill"]')!;
    select.value = "first";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    const publish = () =>
      findButton(page.querySelector(".skill-hub-workspace-publish")!, "Publish");
    await waitForFast(() => expect(publish().disabled).toBe(false));
    publish().click();
    await waitForFast(() => expect(bodies).toHaveLength(1));
    await waitForFast(() => expect(publish().disabled).toBe(false));
    publish().click();
    await waitForFast(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]!.operationId).toBe(bodies[0]!.operationId);
    await waitForFast(() => expect(publish().disabled).toBe(false));
    select.value = "second";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await waitForFast(() =>
      expect(page.querySelector<HTMLInputElement>('[name="version"]')?.value).toBe("2.0.0"),
    );
    publish().click();
    await waitForFast(() => expect(bodies).toHaveLength(3));
    expect(bodies[2]).toMatchObject({ skill: "second", version: "2.0.0" });
    expect(bodies[2]!.operationId).not.toBe(bodies[0]!.operationId);
  });

  it("allows another organization's Part and prevents empty selected sharing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = skillHubRequestUrl(input);
        if (url.endsWith("/config")) {
          return skillHubJson(
            skillHubConfig({ scopes: [{ id: "other-part", kind: "part", name: "Another Part" }] }),
          );
        }
        if (url.includes("/workspace-skills")) {
          return skillHubJson({ source: "platform_server", items: [{ skillKey: "demo" }] });
        }
        return skillHubJson({ items: [], total: 0 });
      }),
    );
    const page = document.createElement("openclaw-skill-hub-page");
    document.body.append(page);
    await waitForFast(() =>
      expect(findButton(page, "Publish workspace skill").disabled).toBe(false),
    );
    findButton(page, "Publish workspace skill").click();
    await waitForFast(() =>
      expect(page.querySelector<HTMLSelectElement>('[name="skill"]')?.value).toBe("demo"),
    );
    const sharing = page.querySelector<HTMLSelectElement>('[name="sharing"]')!;
    sharing.value = "SELECTED";
    sharing.dispatchEvent(new Event("change", { bubbles: true }));
    await waitForFast(() => expect(page.textContent).toContain("Another Part"));
    const publish = () =>
      findButton(page.querySelector(".skill-hub-workspace-publish")!, "Publish");
    expect(publish().disabled).toBe(true);
    const part = page.querySelector<HTMLInputElement>('input[value="other-part"]')!;
    part.click();
    await waitForFast(() => expect(publish().disabled).toBe(false));
    part.click();
    await waitForFast(() => expect(publish().disabled).toBe(true));
    expect(sharing.value).toBe("SELECTED");
  });
});
