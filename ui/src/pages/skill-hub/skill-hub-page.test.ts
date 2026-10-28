/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { skillHubRequestBody, skillHubRequestUrl } from "./skill-hub.test-fixtures.ts";
import {
  skillHubConfig,
  skillHubDetail,
  skillHubEntry,
  skillHubJson,
} from "./skill-hub.test-fixtures.ts";
import "./skill-hub-page.ts";

const findButton = (root: ParentNode, label: string) =>
  [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === label,
  )!;

describe("Skill Hub employee catalog", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
    window.history.replaceState({}, "", window.location.pathname);
  });

  it("identifies pending skills with equal version numbers and only cancels the chosen one", async () => {
    const pending = ["Release checklist", "Research guide"].map((displayName, index) => ({
      displayName,
      slug: `pending-${index}`,
      isMine: true,
      operationId: `operation-${index}`,
      skillId: `pending-${index}`,
      actorUserId: "employee-one",
      version: "1.0.0",
      expectedRevision: 1,
      state: "pending" as const,
      createdAt: 1000,
      updatedAt: 1000,
      fingerprint: "fingerprint",
    }));
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = skillHubRequestUrl(input);
      if (url.endsWith("/config")) {
        return skillHubJson(skillHubConfig({ pendingPublications: pending }));
      }
      if (url.includes("/search?")) {
        return skillHubJson({ items: [], total: 0 });
      }
      if (init?.method === "POST") {
        expect(url).toContain("operation-1");
        pending.splice(1, 1);
        return skillHubJson({ ok: true });
      }
      return skillHubJson({ source: "platform_server", items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const page = document.createElement("openclaw-skill-hub-page");
    document.body.append(page);
    await waitForFast(() =>
      expect(page.querySelectorAll(".skill-hub-pending-publication")).toHaveLength(2),
    );
    const cards = page.querySelectorAll(".skill-hub-pending-publication");
    expect(cards[0]!.querySelector("strong")?.textContent).toBe("Release checklist");
    expect(cards[1]!.querySelector("strong")?.textContent).toBe("Research guide");
    cards[1]!.querySelector<HTMLButtonElement>("button")!.click();
    await waitForFast(() =>
      expect(page.querySelectorAll(".skill-hub-pending-publication")).toHaveLength(1),
    );
    expect(page.querySelector(".skill-hub-pending-publication strong")?.textContent).toBe(
      "Release checklist",
    );
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("shows each version's scan result and renders administrator reasons as text", async () => {
    const entry = skillHubEntry();
    const reason = '<img src="x" onerror="alert(1)">';
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = skillHubRequestUrl(input);
        if (url.endsWith("/config")) {
          return skillHubJson(skillHubConfig());
        }
        if (url.includes("/search?")) {
          return skillHubJson({ items: [entry], total: 1 });
        }
        if (url.endsWith("/history")) {
          return skillHubJson({
            items: [
              {
                id: "history-one",
                action: "metadata-updated",
                actor: { id: "admin", accountId: "admin.user" },
                createdAt: 100,
                details: { reason },
              },
            ],
          });
        }
        if (url.endsWith("/skills/by-id/" + entry.id)) {
          return skillHubJson(
            skillHubDetail({
              versions: [
                {
                  version: "3.0.0",
                  status: "PUBLISHED",
                  downloadAvailable: true,
                  scanner: { status: "warning", badge: "Warnings" },
                },
                {
                  version: "2.0.0",
                  status: "PUBLISHED",
                  downloadAvailable: true,
                  scanner: { status: "unverified", badge: "Not verified" },
                },
                {
                  version: "1.0.0",
                  status: "PUBLISHED",
                  downloadAvailable: false,
                  scanner: { status: "blocked", badge: "Malware blocked", blocked: true },
                },
              ],
            }),
          );
        }
        return skillHubJson({ source: "platform_server", items: [] });
      }),
    );
    const page = document.createElement("openclaw-skill-hub-page");
    document.body.append(page);
    await waitForFast(() => expect(page.querySelector(".skill-hub-card")).not.toBeNull());
    page.querySelector<HTMLButtonElement>(".skill-hub-card")!.click();
    await waitForFast(() => expect(page.querySelectorAll(".skill-hub-version")).toHaveLength(3));
    for (const status of ["warning", "unverified", "blocked"]) {
      expect(
        page.querySelector(".skill-hub-version .is-" + status)?.textContent?.trim(),
      ).toBeTruthy();
    }
    const versions = page.querySelectorAll(".skill-hub-version");
    expect(versions[0]!.querySelector<HTMLInputElement>("input")!.disabled).toBe(false);
    expect(versions[1]!.querySelector<HTMLInputElement>("input")!.disabled).toBe(false);
    expect(versions[2]!.querySelector<HTMLInputElement>("input")!.disabled).toBe(true);
    findButton(page, "Change history").click();
    await waitForFast(() =>
      expect(page.querySelector(".skill-hub-history__reason")?.textContent).toBe(reason),
    );
    expect(page.querySelector(".skill-hub-history img")).toBeNull();
  });

  it("requires and submits an administrator reason when editing another owner's skill", async () => {
    const original = skillHubEntry();
    const entry = { ...original, owner: { ...original.owner, isMine: false } };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = skillHubRequestUrl(input);
      if (url.endsWith("/config")) {
        return skillHubJson(skillHubConfig({ admin: true }));
      }
      if (url.includes("/search?")) {
        return skillHubJson({ items: [entry], total: 1 });
      }
      if (url.endsWith("/skills/by-id/" + entry.id)) {
        return skillHubJson(
          init?.method === "PATCH"
            ? { ok: true }
            : skillHubDetail({ skill: entry, owner: entry.owner }),
        );
      }
      return skillHubJson({ source: "platform_server", items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const page = document.createElement("openclaw-skill-hub-page");
    document.body.append(page);
    await waitForFast(() => expect(page.querySelector(".skill-hub-card")).not.toBeNull());
    page.querySelector<HTMLButtonElement>(".skill-hub-card")!.click();
    await waitForFast(() => expect(findButton(page, "Edit skill")).toBeDefined());
    expect(findButton(page, "Edit skill").disabled).toBe(true);
    const reason = page.querySelector<HTMLTextAreaElement>('[name="adminReason"]')!;
    reason.value = "퇴사자 스킬 설명 정정";
    reason.dispatchEvent(new Event("input", { bubbles: true }));
    await waitForFast(() => expect(findButton(page, "Edit skill").disabled).toBe(false));
    findButton(page, "Edit skill").click();
    await waitForFast(() => expect(page.querySelector(".skill-hub-edit")).not.toBeNull());
    page.querySelector<HTMLButtonElement>('.skill-hub-edit button[type="submit"]')!.click();
    await waitForFast(() =>
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true),
    );
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH")!;
    expect(JSON.parse(skillHubRequestBody(patch[1]?.body))).toMatchObject({
      reason: "퇴사자 스킬 설명 정정",
      expectedRevision: 7,
    });
  });

  it("distinguishes equal names by stable ID and owner, and offers an authenticated ZIP link", async () => {
    const first = skillHubEntry();
    const second = skillHubEntry({
      id: "22222222-2222-4222-8222-222222222222",
      owner: {
        ...first.owner,
        isMine: false,
        user: { id: "person-two", accountId: "person.two", displayName: "Person Two" },
      },
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = skillHubRequestUrl(input);
      if (url.endsWith("/config")) {
        return skillHubJson(skillHubConfig());
      }
      if (url.includes("/search?")) {
        return skillHubJson({ items: [first, second], total: 2 });
      }
      if (url.endsWith(`/skills/by-id/${second.id}`)) {
        return skillHubJson(
          skillHubDetail({ skill: second, owner: second.owner, canManage: false }),
        );
      }
      return skillHubJson({
        source: new URL(url, "http://localhost").searchParams.get("source"),
        items: [],
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const page = document.createElement("openclaw-skill-hub-page");
    document.body.append(page);
    await waitForFast(() => expect(page.querySelectorAll(".skill-hub-card")).toHaveLength(2));
    expect(page.textContent).toContain("Person One");
    expect(page.textContent).toContain("Person Two");
    page.querySelectorAll<HTMLButtonElement>(".skill-hub-card")[1]!.click();
    await waitForFast(() =>
      expect(page.querySelector(".skill-hub-detail h2")?.textContent).toBe("Demo"),
    );
    const detail = page.querySelector(".skill-hub-detail")!;
    expect(findButton(detail, "Edit skill")).toBeUndefined();
    expect(findButton(detail, "Change history")).toBeDefined();
    expect(detail.querySelector<HTMLAnchorElement>("a[download]")?.getAttribute("href")).toContain(
      `/skills/by-id/${second.id}/download?version=1.0.0`,
    );
    expect(new URL(window.location.href).searchParams.get("skill")).toBe(second.id);
    expect(
      fetchMock.mock.calls.some(([url]) =>
        skillHubRequestUrl(url).includes("/skills/engineering/"),
      ),
    ).toBe(false);
  });

  it("moves a skill to trash, explains the recovery period, and restores by stable ID and revision", async () => {
    const entry = skillHubEntry();
    let deleted = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = skillHubRequestUrl(input);
      if (url.endsWith("/config")) {
        return skillHubJson(skillHubConfig());
      }
      if (url.includes("/search?")) {
        return skillHubJson({ items: deleted ? [] : [entry], total: deleted ? 0 : 1 });
      }
      if (url.endsWith("/delete")) {
        deleted = true;
        return skillHubJson({ ok: true });
      }
      if (url.endsWith("/restore")) {
        deleted = false;
        return skillHubJson({ ok: true });
      }
      if (url.endsWith("/trash")) {
        return skillHubJson({
          items: deleted ? [{ ...entry, revision: 8, deletedAt: 1000, purgeAt: 2592001000 }] : [],
        });
      }
      if (url.endsWith(`/skills/by-id/${entry.id}`)) {
        return skillHubJson(skillHubDetail());
      }
      return skillHubJson({
        source: new URL(url, "http://localhost").searchParams.get("source"),
        items: [],
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const page = document.createElement("openclaw-skill-hub-page");
    document.body.append(page);
    await waitForFast(() => expect(page.querySelector(".skill-hub-card")).not.toBeNull());
    page.querySelector<HTMLButtonElement>(".skill-hub-card")!.click();
    await waitForFast(() => expect(findButton(page, "Move to trash")).toBeDefined());
    findButton(page, "Move to trash").click();
    await waitForFast(() => expect(page.querySelectorAll("openclaw-modal-dialog")).toHaveLength(2));
    const confirmation = [...page.querySelectorAll("openclaw-modal-dialog")].find(
      (dialog) =>
        dialog.textContent?.includes("30 days") && !dialog.querySelector(".skill-hub-detail"),
    )!;
    findButton(confirmation, "Move to trash").click();
    await waitForFast(() => expect(page.querySelector(".skill-hub-card")).toBeNull());
    findButton(page, "Trash").click();
    await waitForFast(() => expect(findButton(page, "Restore")).toBeDefined());
    findButton(page, "Restore").click();
    await waitForFast(() => expect(page.querySelector(".skill-hub-card")).not.toBeNull());
    const restore = fetchMock.mock.calls.find(([url]) =>
      skillHubRequestUrl(url).endsWith("/restore"),
    )!;
    expect(JSON.parse(skillHubRequestBody(restore[1]?.body))).toEqual({ expectedRevision: 8 });
    expect(restore[0]).toContain(`/skills/by-id/${entry.id}/restore`);
  });

  it("accepts an ownership request without previewing private contents first", async () => {
    const entry = skillHubEntry();
    let accepted = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = skillHubRequestUrl(input);
      if (url.endsWith("/config")) {
        return skillHubJson(skillHubConfig());
      }
      if (url.endsWith("/transfers")) {
        return skillHubJson({
          items: accepted
            ? []
            : [
                {
                  id: entry.id,
                  displayName: "Private proposal",
                  from: entry.owner.user,
                  revision: 7,
                },
              ],
        });
      }
      if (url.endsWith("/transfer/accept")) {
        accepted = true;
        return skillHubJson({ ok: true });
      }
      return skillHubJson({ items: [], total: 0 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const page = document.createElement("openclaw-skill-hub-page");
    document.body.append(page);
    await waitForFast(() => expect(page.textContent).toContain("No Skill Hub results"));
    findButton(page, "Ownership requests").click();
    await waitForFast(() => expect(page.textContent).toContain("Private proposal"));
    expect(
      fetchMock.mock.calls.some(([url]) =>
        skillHubRequestUrl(url).endsWith(`/skills/by-id/${entry.id}`),
      ),
    ).toBe(false);
    findButton(page, "Accept ownership").click();
    await waitForFast(() => expect(page.textContent).toContain("No pending ownership requests"));
    const accept = fetchMock.mock.calls.find(([url]) =>
      skillHubRequestUrl(url).endsWith("/transfer/accept"),
    )!;
    expect(JSON.parse(skillHubRequestBody(accept[1]?.body))).toEqual({ expectedRevision: 7 });
  });

  it("shows history request failures inside the history dialog", async () => {
    const entry = skillHubEntry();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = skillHubRequestUrl(input);
        if (url.endsWith("/config")) {
          return skillHubJson(skillHubConfig());
        }
        if (url.includes("/search?")) {
          return skillHubJson({ items: [entry], total: 1 });
        }
        if (url.endsWith("/history")) {
          return skillHubJson({ error: "History temporarily unavailable" }, 503);
        }
        if (url.endsWith(`/skills/by-id/${entry.id}`)) {
          return skillHubJson(skillHubDetail());
        }
        return skillHubJson({
          source: new URL(url, "http://localhost").searchParams.get("source"),
          items: [],
        });
      }),
    );
    const page = document.createElement("openclaw-skill-hub-page");
    document.body.append(page);
    await waitForFast(() => expect(page.querySelector(".skill-hub-card")).not.toBeNull());
    page.querySelector<HTMLButtonElement>(".skill-hub-card")!.click();
    await waitForFast(() => expect(findButton(page, "Change history")).toBeDefined());
    findButton(page, "Change history").click();
    await waitForFast(() =>
      expect(page.querySelector(".skill-hub-library [role='alert']")?.textContent).toContain(
        "History temporarily unavailable",
      ),
    );
  });
});
