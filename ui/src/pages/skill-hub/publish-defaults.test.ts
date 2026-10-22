/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import "./skill-hub-page.ts";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Skill Hub publishing defaults", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it("defaults workspace publishing to the active assigned VM", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/config")) {
        return jsonResponse({
          namespaces: ["engineering"],
          defaultNamespace: "engineering",
          namespaceOptions: [{ namespace: "engineering", scopeKind: "global" }],
          maxPackageBytes: 1024,
          activeTarget: "assigned_vm",
          installTargets: [
            { target: "platform_server", available: true, status: "ready" },
            { target: "assigned_vm", available: true, status: "ready" },
          ],
        });
      }
      if (url.includes("/workspace-skills")) {
        return jsonResponse({ source: "assigned_vm", items: [{ skillKey: "vm-only" }] });
      }
      return jsonResponse({ total: 0, items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const page = document.createElement("openclaw-skill-hub-page");
    document.body.append(page);
    await waitForFast(() => expect(page.textContent).toContain("Publish workspace skill"));

    [...page.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Publish workspace skill"))
      ?.click();
    await waitForFast(() => expect(page.textContent).toContain("vm-only"));

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/workspace-skills?source=assigned_vm"),
      expect.any(Object),
    );
    expect(
      page.querySelector<HTMLSelectElement>(".skill-hub-workspace-publish select")?.value,
    ).toBe("assigned_vm");
  });

  it("defaults each member workspace publish to Global and allows an explicit team choice", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/config")) {
        return jsonResponse({
          namespaces: ["engineering", "global"],
          defaultNamespace: "global",
          namespaceOptions: [
            { namespace: "engineering", scopeKind: "team", scopeName: "Engineering" },
            { namespace: "global", scopeKind: "global" },
          ],
          maxPackageBytes: 1024,
          admin: false,
        });
      }
      if (url.includes("/workspace-skills")) {
        return jsonResponse({ source: "platform_server", items: [{ skillKey: "demo" }] });
      }
      if (url.endsWith("/publish")) {
        if (typeof init?.body !== "string") {
          throw new Error("Expected a JSON publish request body");
        }
        const body = JSON.parse(init.body) as { namespace: string };
        return jsonResponse({ namespace: body.namespace, slug: "demo", version: "1.0.0" });
      }
      return jsonResponse({ total: 0, items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const page = document.createElement("openclaw-skill-hub-page");
    document.body.append(page);
    await waitForFast(() => expect(page.textContent).toContain("No Skill Hub results"));
    const action = () =>
      [...page.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
        button.textContent?.includes("Publish workspace skill"),
      )!;
    const open = async () => {
      expect(action().disabled).toBe(false);
      action().click();
      await waitForFast(() =>
        expect(
          page.querySelectorAll<HTMLSelectElement>(".skill-hub-workspace-publish select")[1]?.value,
        ).toBe("demo"),
      );
      return page.querySelectorAll<HTMLSelectElement>(".skill-hub-workspace-publish select")[2]!;
    };
    const publish = () =>
      page.querySelector<HTMLButtonElement>(".skill-hub-workspace-publish button.primary")!.click();

    const destination = await open();
    expect(destination.value).toBe("global");
    expect(destination.textContent).toContain("Company-wide (global)");
    expect(destination.textContent).toContain("Team: Engineering (engineering)");
    publish();
    await waitForFast(() => expect(page.textContent).toContain("Published global/demo@1.0.0"));

    const teamDestination = await open();
    teamDestination.value = "engineering";
    teamDestination.dispatchEvent(new Event("change", { bubbles: true }));
    await waitForFast(() => expect(teamDestination.value).toBe("engineering"));
    publish();
    await waitForFast(() => expect(page.textContent).toContain("Published engineering/demo@1.0.0"));
    expect((await open()).value).toBe("global");

    const published = fetchMock.mock.calls
      .filter(([input]) =>
        (input instanceof Request ? input.url : input.toString()).endsWith("/publish"),
      )
      .map(([, init]) => {
        if (typeof init?.body !== "string") {
          throw new Error("Expected a JSON publish request body");
        }
        return JSON.parse(init.body) as { namespace: string };
      });
    expect(published.map((body) => body.namespace)).toEqual(["global", "engineering"]);
    expect(page.textContent).not.toContain("Skill Hub admin");
  });

  it("resets ZIP publishing to Global when reopened after choosing a team", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        jsonResponse(
          (input instanceof Request ? input.url : input.toString()).endsWith("/config")
            ? {
                namespaces: ["engineering", "global"],
                defaultNamespace: "global",
                namespaceOptions: [
                  { namespace: "engineering", scopeKind: "team", scopeName: "Engineering" },
                  { namespace: "global", scopeKind: "global" },
                ],
                maxPackageBytes: 1024,
                admin: false,
              }
            : { total: 0, items: [] },
        ),
      ),
    );
    const page = document.createElement("openclaw-skill-hub-page");
    document.body.append(page);
    await waitForFast(() => expect(page.textContent).toContain("No Skill Hub results"));
    const open = () =>
      [...page.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.trim() === "Upload ZIP")!
        .click();
    open();
    await waitForFast(() => expect(page.querySelector(".skill-hub-upload")).not.toBeNull());
    const destination = page.querySelector<HTMLSelectElement>(".skill-hub-upload select")!;
    expect(destination.value).toBe("global");
    destination.value = "engineering";
    destination.dispatchEvent(new Event("change", { bubbles: true }));
    page.querySelector<HTMLButtonElement>(".skill-hub-upload header button")!.click();
    await waitForFast(() => expect(page.querySelector(".skill-hub-upload")).toBeNull());
    open();
    await waitForFast(() =>
      expect(page.querySelector<HTMLSelectElement>(".skill-hub-upload select")?.value).toBe(
        "global",
      ),
    );
  });
});
