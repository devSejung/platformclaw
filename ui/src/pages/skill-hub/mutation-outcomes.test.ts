/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { SkillHubPage } from "./skill-hub-page.ts";
import {
  skillHubConfig,
  skillHubDetail,
  skillHubEntry,
  skillHubJson,
  skillHubRequestBody,
  skillHubRequestUrl,
} from "./skill-hub.test-fixtures.ts";

function button(root: ParentNode, label: string): HTMLButtonElement {
  const found = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.trim() === label,
  );
  if (!found) {
    throw new Error(`Missing button: ${label}`);
  }
  return found;
}

function input(root: ParentNode, name: string, value: string): void {
  const field = root.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
  field.value = value;
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

function chooseZip(root: ParentNode): void {
  const field = root.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(field, "files", {
    configurable: true,
    value: [new File(["fixture package"], "demo.zip", { type: "application/zip" })],
  });
  field.dispatchEvent(new Event("change", { bubbles: true }));
}

async function mount() {
  const page = document.createElement("openclaw-skill-hub-page");
  if (!(page instanceof SkillHubPage)) {
    throw new Error("Skill Hub element was not registered");
  }
  document.body.append(page);
  await waitForFast(() => expect(page.querySelector(".skill-hub-card")).not.toBeNull());
  page.querySelector<HTMLButtonElement>(".skill-hub-card")!.click();
  await waitForFast(() => expect(page.querySelector(".skill-hub-management")).not.toBeNull());
  return page;
}

describe("Skill Hub committed mutation outcomes", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });
  afterEach(() => {
    document.body.replaceChildren();
    window.history.replaceState({}, "", window.location.pathname);
    vi.unstubAllGlobals();
  });

  it.each([
    { action: "workspace", outcome: "Published demo@2.0.0 from Basic workspace." },
    { action: "zip", outcome: "Published demo@2.0.0 from ZIP." },
    { action: "edit", outcome: "Updated Demo." },
    { action: "delete", outcome: "Moved demo to trash." },
    { action: "icon", outcome: "Skill icon updated." },
  ] as const)(
    "keeps the committed $action outcome visible when config refresh fails",
    async ({ action, outcome }) => {
      const entry = skillHubEntry({ iconUrl: "/fixture-icon.png" });
      let committed = false;
      let failRefresh!: (value: Response) => void;
      const refresh = new Promise<Response>((resolve) => {
        failRefresh = resolve;
      });
      const mutations: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
          const url = skillHubRequestUrl(request);
          if (url.endsWith("/config")) {
            return committed ? refresh : skillHubJson(skillHubConfig());
          }
          if (init?.method && init.method !== "GET") {
            mutations.push(url);
            committed = true;
            return skillHubJson({ id: entry.id, slug: entry.slug, version: "2.0.0", ok: true });
          }
          if (url.includes("/search?")) {
            return skillHubJson({ items: [entry], total: 1 });
          }
          if (url.endsWith(`/skills/by-id/${entry.id}`)) {
            return skillHubJson(skillHubDetail({ skill: entry }));
          }
          return skillHubJson({ source: "platform_server", items: [{ skillKey: "demo" }] });
        }),
      );
      const page = await mount();
      const detail = page.querySelector(".skill-hub-detail")!;
      if (action === "workspace") {
        button(detail, "From workspace").click();
        await waitForFast(() =>
          expect(page.querySelector<HTMLSelectElement>('[name="skill"]')?.value).toBe("demo"),
        );
        const dialog = page.querySelector(".skill-hub-workspace-publish")!;
        input(dialog, "version", "2.0.0");
        button(dialog, "Publish").click();
      } else if (action === "zip") {
        button(detail, "From ZIP").click();
        await waitForFast(() => expect(page.querySelector(".skill-hub-upload")).not.toBeNull());
        const dialog = page.querySelector(".skill-hub-upload")!;
        chooseZip(dialog);
        input(dialog, "version", "2.0.0");
        await waitForFast(() => expect(button(dialog, "Publish").disabled).toBe(false));
        button(dialog, "Publish").click();
      } else if (action === "edit") {
        button(detail, "Edit skill").click();
        await waitForFast(() => expect(page.querySelector(".skill-hub-edit")).not.toBeNull());
        button(page.querySelector(".skill-hub-edit")!, "Save changes").click();
      } else if (action === "delete") {
        button(detail, "Move to trash").click();
        await waitForFast(() =>
          expect(page.querySelectorAll("openclaw-modal-dialog")).toHaveLength(2),
        );
        const confirmation = [...page.querySelectorAll("openclaw-modal-dialog")].find(
          (dialog) => !dialog.querySelector(".skill-hub-detail"),
        )!;
        button(confirmation, "Move to trash").click();
      } else {
        button(detail, "Use default icon").click();
      }
      await waitForFast(() =>
        expect(
          page.querySelector('.skill-hub-page .callout.success[role="status"]')?.textContent,
        ).toContain(outcome),
      );
      expect(mutations).toHaveLength(1);
      expect(
        page.querySelector(".skill-hub-workspace-publish, .skill-hub-upload, .skill-hub-edit"),
      ).toBeNull();
      failRefresh(skillHubJson({ error: "Latest catalog unavailable" }, 503));
      await waitForFast(() => {
        const warning = page.querySelector('.skill-hub-page .callout.warning[role="status"]');
        expect(warning?.textContent).toContain(outcome);
        expect(warning?.textContent).toContain("Latest catalog unavailable");
        expect(warning?.textContent).toContain("Reload this page before another change");
      });
      if (action === "delete") {
        expect(page.querySelector("openclaw-modal-dialog")).toBeNull();
      }
      expect(mutations).toHaveLength(1);
    },
  );

  it.each(["updated", "failed", "dismissed"] as const)(
    "refreshes the current workspace publication detail without reopening a %s view",
    async (scenario) => {
      const original = skillHubEntry();
      let published = false;
      let detailReads = 0;
      let searchReads = 0;
      let finishRefresh!: (value: Response) => void;
      const pendingConfig = new Promise<Response>((resolve) => {
        finishRefresh = resolve;
      });
      const edits: unknown[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
          const url = skillHubRequestUrl(request);
          const entry = published ? { ...original, revision: 8, latestVersion: "2.0.0" } : original;
          if (url.endsWith("/config")) {
            return published && scenario === "dismissed"
              ? pendingConfig
              : skillHubJson(skillHubConfig());
          }
          if (url.endsWith("/publish")) {
            published = true;
            return skillHubJson({ id: entry.id, slug: entry.slug, version: "2.0.0" });
          }
          if (init?.method === "PATCH") {
            edits.push(JSON.parse(skillHubRequestBody(init.body)));
            return skillHubJson({ ok: true });
          }
          if (url.includes("/search?")) {
            searchReads += 1;
            return skillHubJson({ items: [entry], total: 1 });
          }
          if (url.endsWith(`/skills/by-id/${entry.id}`)) {
            detailReads += 1;
            return published && scenario === "failed"
              ? skillHubJson({ error: "Latest detail unavailable" }, 503)
              : skillHubJson(
                  skillHubDetail({
                    skill: entry,
                    versions: [
                      ...(published
                        ? [{ version: "2.0.0", status: "PUBLISHED", downloadAvailable: true }]
                        : []),
                      { version: "1.0.0", status: "PUBLISHED", downloadAvailable: true },
                    ],
                  }),
                );
          }
          return skillHubJson({
            source: "platform_server",
            items: [{ skillKey: "demo", version: "2.0.0" }],
          });
        }),
      );
      const page = await mount();
      button(page.querySelector(".skill-hub-detail")!, "From workspace").click();
      await waitForFast(() =>
        expect(page.querySelector<HTMLSelectElement>('[name="skill"]')?.value).toBe("demo"),
      );
      button(page.querySelector(".skill-hub-workspace-publish")!, "Publish").click();
      await waitForFast(() =>
        expect(
          page.querySelector('.skill-hub-page .callout[role="status"]')?.textContent,
        ).toContain("Published demo@2.0.0"),
      );
      if (scenario === "dismissed") {
        button(page.querySelector(".skill-hub-detail")!, "Close").click();
        finishRefresh(skillHubJson(skillHubConfig()));
        await waitForFast(() => expect(searchReads).toBe(2));
        await page.updateComplete;
        await waitForFast(() => expect(page.querySelector(".skill-hub-detail")).toBeNull());
        expect(new URL(window.location.href).searchParams.has("skill")).toBe(false);
        expect(detailReads).toBe(1);
      } else if (scenario === "failed") {
        await waitForFast(() =>
          expect(page.querySelector(".skill-hub-page .callout.warning")?.textContent).toContain(
            "Latest detail unavailable",
          ),
        );
        expect(page.querySelector(".skill-hub-page .callout.warning")?.textContent).toContain(
          "Published demo@2.0.0",
        );
        expect(page.querySelector(".skill-hub-workspace-publish")).toBeNull();
      } else {
        await waitForFast(() =>
          expect(page.querySelectorAll(".skill-hub-version")).toHaveLength(2),
        );
        expect(
          page.querySelector<HTMLInputElement>('[name="skill-hub-version"]:checked')?.value,
        ).toBe("2.0.0");
        button(page.querySelector(".skill-hub-detail")!, "Edit skill").click();
        await waitForFast(() => expect(page.querySelector(".skill-hub-edit")).not.toBeNull());
        button(page.querySelector(".skill-hub-edit")!, "Save changes").click();
        await waitForFast(() => expect(edits).toHaveLength(1));
        expect(edits[0]).toMatchObject({ expectedRevision: 8 });
      }
    },
  );

  it.each([
    {
      kind: "trash",
      open: "Trash",
      action: "Restore",
      endpoint: "/restore",
      outcome: "Restored Demo.",
    },
    {
      kind: "transfers",
      open: "Ownership requests",
      action: "Accept ownership",
      endpoint: "/transfer/accept",
      outcome: "Accepted ownership of Demo.",
    },
  ] as const)(
    "removes the committed $kind action even when its list refresh fails",
    async ({ kind, open, action, endpoint, outcome }) => {
      const entry = skillHubEntry();
      let committed = false;
      const writes: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
          const url = skillHubRequestUrl(request);
          if (url.endsWith("/config")) {
            return skillHubJson(skillHubConfig());
          }
          if (url.endsWith(endpoint) && init?.method === "POST") {
            committed = true;
            writes.push(url);
            return skillHubJson({ ok: true });
          }
          if (url.endsWith(`/${kind}`)) {
            return committed
              ? skillHubJson({ error: "Latest list unavailable" }, 503)
              : skillHubJson({
                  items: [{ ...entry, deletedAt: 1, purgeAt: 100000, from: entry.owner.user }],
                });
          }
          return skillHubJson({ items: [entry], total: 1 });
        }),
      );
      const page = document.createElement("openclaw-skill-hub-page");
      document.body.append(page);
      await waitForFast(() => expect(page.querySelector(".skill-hub-card")).not.toBeNull());
      button(page, open).click();
      await waitForFast(() => expect(page.querySelector(".skill-hub-library-list")).not.toBeNull());
      button(page.querySelector(".skill-hub-library")!, action).click();
      await waitForFast(() => {
        const panel = page.querySelector(".skill-hub-library")!;
        expect(panel.querySelector('.callout.warning[role="status"]')?.textContent).toContain(
          outcome,
        );
        expect(panel.querySelector('.callout.warning[role="status"]')?.textContent).toContain(
          "Latest list unavailable",
        );
        expect(
          [...panel.querySelectorAll("button")].some((item) => item.textContent?.trim() === action),
        ).toBe(false);
      });
      expect(writes).toHaveLength(1);
    },
  );
});
