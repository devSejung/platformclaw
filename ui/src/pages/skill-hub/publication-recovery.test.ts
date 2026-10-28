/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  skillHubConfig,
  skillHubJson,
  skillHubRequestBody,
  skillHubRequestUrl,
} from "./skill-hub.test-fixtures.ts";
import "./skill-hub-page.ts";

function button(root: ParentNode, text: string): HTMLButtonElement {
  const item = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) => element.textContent?.trim() === text,
  );
  if (!item) {
    throw new Error(`Missing button: ${text}`);
  }
  return item;
}

function field(root: ParentNode, name: string, value: string, event = "input"): void {
  const input = root.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
  input.value = value;
  input.dispatchEvent(new Event(event, { bubbles: true }));
}

function chooseFile(root: ParentNode, file: File): void {
  const input = root.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

async function mount() {
  const page = document.createElement("openclaw-skill-hub-page");
  document.body.append(page);
  await waitForFast(() => expect(button(page, "Publish workspace skill").disabled).toBe(false));
  return page;
}

describe("Skill Hub publication request recovery", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    window.history.replaceState({}, "", window.location.pathname);
  });

  it.each(["platform_server", "assigned_vm"] as const)(
    "restores the exact %s request after edits and reopening, keeping other requests independent",
    async (source) => {
      const requests: Array<Record<string, unknown>> = [];
      let configReads = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = skillHubRequestUrl(input);
          if (url.endsWith("/config")) {
            configReads += 1;
            return skillHubJson(skillHubConfig({ activeTarget: source }));
          }
          if (url.includes("/workspace-skills")) {
            return skillHubJson({ source, items: [{ skillKey: "demo", revision: "original" }] });
          }
          if (url.endsWith("/publish")) {
            requests.push(JSON.parse(skillHubRequestBody(init?.body)));
            return skillHubJson({ error: "Publication result unavailable" }, 503);
          }
          return skillHubJson({ items: [], total: 0 });
        }),
      );
      const page = await mount();
      button(page, "Publish workspace skill").click();
      const dialog = () => page.querySelector(".skill-hub-workspace-publish")!;
      const publish = () => button(dialog(), "Publish");
      await waitForFast(() => expect(publish().disabled).toBe(false));
      field(dialog(), "sharing", "PRIVATE", "change");
      await waitForFast(() =>
        expect(dialog().querySelector<HTMLSelectElement>('[name="sharing"]')?.value).toBe(
          "PRIVATE",
        ),
      );
      publish().click();
      await waitForFast(() =>
        expect(button(dialog(), "Restore original request").disabled).toBe(false),
      );
      expect(configReads).toBe(2);
      const original = requests[0]!;
      field(dialog(), "version", "2.0.0");
      await waitForFast(() => expect(publish().disabled).toBe(false));
      publish().click();
      await waitForFast(() => expect(requests).toHaveLength(2));
      await waitForFast(() => expect(publish().disabled).toBe(false));
      expect(requests[1]!.operationId).not.toBe(original.operationId);
      field(dialog(), "version", "1.0.0");
      await waitForFast(() => expect(publish().disabled).toBe(false));
      publish().click();
      await waitForFast(() => expect(requests).toHaveLength(3));
      await waitForFast(() => expect(publish().disabled).toBe(false));
      expect(requests[2]).toEqual(original);
      button(dialog(), "Close").click();
      await waitForFast(() =>
        expect(page.querySelector(".skill-hub-workspace-publish")).toBeNull(),
      );
      button(page, "Publish workspace skill").click();
      await waitForFast(() => expect(publish().disabled).toBe(false));
      expect(dialog().querySelector<HTMLSelectElement>('[name="sharing"]')?.value).toBe("PUBLIC");
      dialog()
        .querySelector<HTMLButtonElement>(`[data-operation-id="${String(original.operationId)}"]`)!
        .click();
      await waitForFast(() =>
        expect(dialog().querySelector<HTMLSelectElement>('[name="sharing"]')?.value).toBe(
          "PRIVATE",
        ),
      );
      publish().click();
      await waitForFast(() => expect(requests).toHaveLength(4));
      expect(requests[3]).toEqual(original);
    },
  );

  it.each(["platform_server", "assigned_vm"] as const)(
    "restarts the unchanged %s draft after another tab confirms cancellation",
    async (source) => {
      const requests: Array<Record<string, unknown>> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = skillHubRequestUrl(input);
          if (url.endsWith("/config")) {
            return skillHubJson(skillHubConfig({ activeTarget: source }));
          }
          if (url.includes("/workspace-skills")) {
            return skillHubJson({
              source,
              targetId: "original-target",
              targetRevision: 1,
              items: [{ skillKey: "demo", revision: "original" }],
            });
          }
          if (url.endsWith("/publish")) {
            const request: Record<string, unknown> = JSON.parse(skillHubRequestBody(init?.body));
            requests.push(request);
            if (requests.length === 1) {
              return skillHubJson({ error: "Receipt unavailable" }, 503);
            }
            return request.operationId === requests[0]!.operationId
              ? skillHubJson(
                  {
                    error: "Cancelled in another tab",
                    details: { code: "skill-hub-publication-cancelled" },
                  },
                  409,
                )
              : skillHubJson({ id: "new-entry", slug: "demo", version: "2.3.4" });
          }
          return skillHubJson({ items: [], total: 0 });
        }),
      );
      const page = await mount();
      button(page, "Publish workspace skill").click();
      const dialog = () => page.querySelector(".skill-hub-workspace-publish")!;
      await waitForFast(() => expect(button(dialog(), "Publish").disabled).toBe(false));
      field(dialog(), "version", "2.3.4");
      field(dialog(), "sharing", "PRIVATE", "change");
      button(dialog(), "Publish").click();
      await waitForFast(() =>
        expect(button(dialog(), "Restore original request").disabled).toBe(false),
      );
      button(dialog(), "Publish").click();
      await waitForFast(() =>
        expect(dialog().textContent).toContain("This publication request was cancelled."),
      );
      await waitForFast(() => expect(button(dialog(), "Publish").disabled).toBe(false));
      expect(requests[1]).toEqual(requests[0]);
      button(dialog(), "Publish").click();
      await waitForFast(() => expect(requests).toHaveLength(3));
      expect(requests[2]!.operationId).not.toBe(requests[0]!.operationId);
      expect(requests[2]).toEqual({ ...requests[0], operationId: requests[2]!.operationId });
      expect(requests[2]).toMatchObject({
        source,
        expectedTargetId: "original-target",
        version: "2.3.4",
        sharing: { mode: "PRIVATE", userIds: [], scopeIds: [] },
      });
      await waitForFast(() =>
        expect(page.querySelector(".skill-hub-workspace-publish")).toBeNull(),
      );
      button(page, "Publish workspace skill").click();
      await waitForFast(() => expect(button(dialog(), "Publish").disabled).toBe(false));
      expect(dialog().querySelector(".skill-hub-publication-recovery")).toBeNull();
    },
  );

  it("retains the original ZIP File without reading bytes and never adopts its ID for a different file", async () => {
    const requests: Array<{ url: URL; file: RequestInit["body"] }> = [];
    let committed = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = skillHubRequestUrl(input);
        if (url.endsWith("/config")) {
          return committed
            ? skillHubJson({ error: "Read unavailable" }, 503)
            : skillHubJson(skillHubConfig());
        }
        if (url.includes("/publish/upload?")) {
          requests.push({ url: new URL(url, "http://localhost"), file: init?.body });
          if (requests.length === 3) {
            committed = true;
            return skillHubJson({ id: "published", slug: "demo", version: "1.0.0" });
          }
          throw new TypeError("Network connection lost");
        }
        return skillHubJson({ items: [], total: 0 });
      }),
    );
    const page = await mount();
    button(page, "Upload ZIP").click();
    const dialog = () => page.querySelector(".skill-hub-upload")!;
    const publish = () => button(dialog(), "Publish");
    const originalFile = new File(["original"], "demo.zip", {
      type: "application/zip",
      lastModified: 1,
    });
    const otherFile = new File(["modified"], "demo.zip", {
      type: "application/zip",
      lastModified: 1,
    });
    await waitForFast(() => expect(dialog()).not.toBeNull());
    chooseFile(dialog(), originalFile);
    field(dialog(), "slug", "demo");
    await waitForFast(() => expect(publish().disabled).toBe(false));
    publish().click();
    await waitForFast(() =>
      expect(button(dialog(), "Restore original request").disabled).toBe(false),
    );
    const originalId = requests[0]!.url.searchParams.get("operationId")!;
    chooseFile(dialog(), otherFile);
    field(dialog(), "version", "2.0.0");
    await waitForFast(() => expect(publish().disabled).toBe(false));
    publish().click();
    await waitForFast(() => expect(requests).toHaveLength(2));
    await waitForFast(() => expect(publish().disabled).toBe(false));
    expect(requests[1]!.url.searchParams.get("operationId")).not.toBe(originalId);
    expect(requests[1]!.file).toBe(otherFile);
    button(dialog(), "Close").click();
    await waitForFast(() => expect(page.querySelector(".skill-hub-upload")).toBeNull());
    button(page, "Upload ZIP").click();
    await waitForFast(() =>
      expect(dialog().querySelector(`[data-operation-id="${originalId}"]`)).not.toBeNull(),
    );
    dialog().querySelector<HTMLButtonElement>(`[data-operation-id="${originalId}"]`)!.click();
    await waitForFast(() => expect(publish().disabled).toBe(false));
    publish().click();
    await waitForFast(() => expect(requests).toHaveLength(3));
    await waitForFast(() => expect(page.textContent).toContain("Published demo@1.0.0 from ZIP."));
    expect(requests[2]!.file).toBe(originalFile);
    expect(requests[2]!.url.href).toBe(requests[0]!.url.href);
    expect(page.textContent).toContain("Read unavailable");
    button(page, "Upload ZIP").click();
    await waitForFast(() =>
      expect(dialog().querySelector(`[data-operation-id="${originalId}"]`)).toBeNull(),
    );
    expect(dialog().querySelector(".skill-hub-publication-recovery")).not.toBeNull();
  });

  it.each([false, true])(
    "forgets an earlier request only after confirmed cancellation (cancel succeeds: %s)",
    async (cancelSucceeds) => {
      const requests: Array<{ operationId: string }> = [];
      let cancelled = false;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = skillHubRequestUrl(input);
          if (url.endsWith("/config")) {
            return skillHubJson(
              skillHubConfig({
                pendingPublications:
                  requests.length && !cancelled
                    ? [
                        {
                          operationId: requests[0]!.operationId,
                          skillId: "catalog-entry",
                          actorUserId: "employee-one",
                          displayName: "Demo",
                          version: "1.0.0",
                          expectedRevision: 1,
                          isMine: true,
                          state: "pending",
                          createdAt: 1,
                          updatedAt: 1,
                          fingerprint: "original",
                        },
                      ]
                    : [],
              }),
            );
          }
          if (url.includes("/workspace-skills")) {
            return skillHubJson({ source: "platform_server", items: [{ skillKey: "demo" }] });
          }
          if (url.endsWith("/publish")) {
            requests.push(JSON.parse(skillHubRequestBody(init?.body)));
            return skillHubJson({ error: "Publication unavailable" }, 503);
          }
          if (url.endsWith("/cancel")) {
            cancelled = cancelSucceeds;
            return cancelSucceeds
              ? skillHubJson({ ok: true })
              : skillHubJson({ error: "Cancellation unavailable" }, 503);
          }
          return skillHubJson({ items: [], total: 0 });
        }),
      );
      const page = await mount();
      button(page, "Publish workspace skill").click();
      const dialog = () => page.querySelector(".skill-hub-workspace-publish")!;
      await waitForFast(() => expect(button(dialog(), "Publish").disabled).toBe(false));
      button(dialog(), "Publish").click();
      await waitForFast(() =>
        expect(button(dialog(), "Restore original request").disabled).toBe(false),
      );
      expect(page.querySelector(".skill-hub-pending-publication")?.textContent).toContain("Demo");
      button(dialog(), "Close").click();
      await waitForFast(() =>
        expect(page.querySelector(".skill-hub-workspace-publish")).toBeNull(),
      );
      button(page, "Cancel pending publication").click();
      await waitForFast(() =>
        expect(page.textContent).toContain(
          cancelSucceeds ? "Pending publication cancelled." : "Cancellation unavailable",
        ),
      );
      button(page, "Publish workspace skill").click();
      await waitForFast(() => expect(button(dialog(), "Publish").disabled).toBe(false));
      expect(dialog().querySelector(".skill-hub-publication-recovery") === null).toBe(
        cancelSucceeds,
      );
      button(dialog(), "Publish").click();
      await waitForFast(() => expect(requests).toHaveLength(2));
      expect(requests[1]!.operationId === requests[0]!.operationId).toBe(!cancelSucceeds);
    },
  );

  it("keeps a rejected request recoverable without presenting it as canonical pending when refresh also fails", async () => {
    let attempted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = skillHubRequestUrl(input);
        if (url.endsWith("/config")) {
          return attempted
            ? skillHubJson({ error: "Read unavailable" }, 503)
            : skillHubJson(skillHubConfig());
        }
        if (url.includes("/workspace-skills")) {
          return skillHubJson({ source: "platform_server", items: [{ skillKey: "demo" }] });
        }
        if (url.endsWith("/publish")) {
          attempted = true;
          return skillHubJson({ error: "Invalid version" }, 400);
        }
        return skillHubJson({ items: [], total: 0 });
      }),
    );
    const page = await mount();
    button(page, "Publish workspace skill").click();
    const dialog = () => page.querySelector(".skill-hub-workspace-publish")!;
    await waitForFast(() => expect(button(dialog(), "Publish").disabled).toBe(false));
    button(dialog(), "Publish").click();
    await waitForFast(() =>
      expect(button(dialog(), "Restore original request").disabled).toBe(false),
    );
    expect(dialog().textContent).toContain("Invalid version");
    expect(page.querySelector(".skill-hub-pending-publication")).toBeNull();
  });

  it("allows closing a failed publication while its canonical pending refresh is still waiting", async () => {
    let attempted = false;
    let resolveRead!: (response: Response) => void;
    const read = new Promise<Response>((resolve) => {
      resolveRead = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = skillHubRequestUrl(input);
        if (url.endsWith("/config")) {
          return attempted ? read : skillHubJson(skillHubConfig());
        }
        if (url.includes("/workspace-skills")) {
          return skillHubJson({ source: "platform_server", items: [{ skillKey: "demo" }] });
        }
        if (url.endsWith("/publish")) {
          attempted = true;
          return skillHubJson({ error: "Result unavailable" }, 503);
        }
        return skillHubJson({ items: [], total: 0 });
      }),
    );
    const page = await mount();
    button(page, "Publish workspace skill").click();
    const dialog = () => page.querySelector(".skill-hub-workspace-publish")!;
    await waitForFast(() => expect(button(dialog(), "Publish").disabled).toBe(false));
    button(dialog(), "Publish").click();
    await waitForFast(() =>
      expect(button(dialog(), "Restore original request").disabled).toBe(false),
    );
    button(dialog(), "Close").click();
    await waitForFast(() => expect(page.querySelector(".skill-hub-workspace-publish")).toBeNull());
    resolveRead(skillHubJson({ error: "Read unavailable" }, 503));
    await read;
  });

  it("keeps the successful retry's config when the older failed-attempt pending read arrives last", async () => {
    let configReads = 0;
    const requests: Array<{ operationId: string }> = [];
    let resolveOldRead!: (response: Response) => void;
    const oldRead = new Promise<Response>((resolve) => {
      resolveOldRead = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = skillHubRequestUrl(input);
        if (url.endsWith("/config")) {
          configReads += 1;
          return configReads === 2 ? oldRead : skillHubJson(skillHubConfig());
        }
        if (url.includes("/workspace-skills")) {
          return skillHubJson({ source: "platform_server", items: [{ skillKey: "demo" }] });
        }
        if (url.endsWith("/publish")) {
          requests.push(JSON.parse(skillHubRequestBody(init?.body)));
          return requests.length === 1
            ? skillHubJson({ error: "Result unavailable" }, 503)
            : skillHubJson({ id: "catalog-entry", slug: "demo", version: "1.0.0" });
        }
        return skillHubJson({ items: [], total: 0 });
      }),
    );
    const page = await mount();
    button(page, "Publish workspace skill").click();
    const dialog = () => page.querySelector(".skill-hub-workspace-publish")!;
    await waitForFast(() => expect(button(dialog(), "Publish").disabled).toBe(false));
    button(dialog(), "Publish").click();
    await waitForFast(() =>
      expect(button(dialog(), "Restore original request").disabled).toBe(false),
    );
    expect(configReads).toBe(2);
    button(dialog(), "Publish").click();
    await waitForFast(() => expect(configReads).toBe(3));
    await waitForFast(() =>
      expect(page.textContent).toContain("Published demo@1.0.0 from Basic workspace."),
    );
    expect(requests[1]!.operationId).toBe(requests[0]!.operationId);
    resolveOldRead(
      skillHubJson(
        skillHubConfig({
          pendingPublications: [
            {
              operationId: requests[0]!.operationId,
              skillId: "catalog-entry",
              actorUserId: "employee-one",
              displayName: "Demo",
              version: "1.0.0",
              expectedRevision: 1,
              isMine: true,
              state: "pending",
              createdAt: 1,
              updatedAt: 1,
              fingerprint: "original",
            },
          ],
        }),
      ),
    );
    await oldRead;
    // Drain the completed response's JSON and Lit microtasks before checking the stale write.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(page.querySelector(".skill-hub-pending-publication")).toBeNull();
    expect(page.textContent).toContain("Published demo@1.0.0 from Basic workspace.");
  });
});
