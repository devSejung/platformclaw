/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANNOUNCEMENTS_ADMIN_PATH,
  ANNOUNCEMENTS_HISTORY_PATH,
  type AnnouncementAdministrationSnapshot,
  type AnnouncementHistoryEntry,
  type AnnouncementHistoryPage,
} from "../../../packages/platformclaw-control-plane/src/announcement-contracts.js";
import { i18n } from "../i18n/index.ts";
import { loadPlatformClawLocale } from "./i18n.ts";
import "./announcement-administration.ts";

const NOW = new Date("2030-04-15T10:20:37Z").getTime();
const DAY = 24 * 60 * 60_000;
const CURRENT = {
  id: "notice-one",
  revision: 4,
  title: "Existing maintenance",
  body: "Existing plain text",
  kind: "maintenance" as const,
  maintenanceAt: NOW + 3_600_000,
  expiresAt: NOW + DAY,
  cancelled: false,
};
const EMPTY: AnnouncementAdministrationSnapshot = {
  revision: 0,
  serverNow: NOW,
  announcement: null,
  current: null,
};
const ACTIVE: AnnouncementAdministrationSnapshot = {
  ...EMPTY,
  revision: CURRENT.revision,
  current: CURRENT,
  announcement: CURRENT,
};
const HISTORY: AnnouncementHistoryEntry = {
  id: "audit-one",
  announcementId: CURRENT.id,
  revision: CURRENT.revision,
  action: "publish",
  occurredAt: NOW,
  announcement: CURRENT,
};
const EMPTY_HISTORY: AnnouncementHistoryPage = { items: [], nextCursor: null };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function localTime(timestamp: number): string {
  return new Date(timestamp - new Date(timestamp).getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
}

function mockServer(
  options: {
    read?: () => Response | Promise<Response>;
    write?: () => Response | Promise<Response>;
    history?: (url: URL) => Response | Promise<Response>;
  } = {},
) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input), "https://example.test");
    if (url.pathname === ANNOUNCEMENTS_HISTORY_PATH) {
      return options.history?.(url) ?? jsonResponse(EMPTY_HISTORY);
    }
    expect(url.pathname).toBe(ANNOUNCEMENTS_ADMIN_PATH);
    return init?.method === "POST"
      ? (options.write?.() ?? jsonResponse(ACTIVE))
      : (options.read?.() ?? jsonResponse(EMPTY));
  });
}

function posts(fetchImpl: ReturnType<typeof mockServer>) {
  return fetchImpl.mock.calls
    .filter(([, init]) => init?.method === "POST")
    .map(([, init]) => JSON.parse(init!.body as string) as Record<string, unknown>);
}

function mount(fetchImpl: typeof fetch, onUnauthenticated = vi.fn()) {
  const element = document.createElement(
    "platformclaw-announcement-administration",
  ) as HTMLElement & {
    fetchImpl: typeof fetch;
    onUnauthenticated: () => void;
  };
  element.fetchImpl = fetchImpl;
  element.onUnauthenticated = onUnauthenticated;
  document.body.append(element);
  return element;
}

function fill(root: ShadowRoot, name: string, value: string): void {
  const input = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name='${name}']`)!;
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function button(root: ShadowRoot, action: string) {
  return root.querySelector<HTMLButtonElement>(`[data-action='${action}']`)!;
}

function submit(root: ShadowRoot, preview = false) {
  root
    .querySelector<HTMLFormElement>("form")!
    .requestSubmit(
      button(
        root,
        preview ? "preview" : root.querySelector("[data-action='update']") ? "update" : "publish",
      ),
    );
}

async function selectKind(root: ShadowRoot, kind: string) {
  const select = root.querySelector<HTMLSelectElement>("[name='kind']")!;
  select.value = kind;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await vi.waitFor(() =>
    expect(Boolean(root.querySelector("[name='maintenanceAt']"))).toBe(kind === "maintenance"),
  );
}

async function ready(element: HTMLElement): Promise<ShadowRoot> {
  const root = element.shadowRoot!;
  await vi.waitFor(() => expect(button(root, "publish")?.disabled).toBe(false));
  return root;
}

async function settle() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

beforeEach(async () => {
  await i18n.setLocale("en");
  await loadPlatformClawLocale();
});

afterEach(async () => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  await i18n.setLocale("en");
});

describe("announcement administration page", () => {
  it.each([
    ["en", false],
    ["en", true],
    ["ko", false],
    ["ko", true],
  ] as const)(
    "publishes a revision-pinned draft in %s with optional preview=%s",
    async (locale, preview) => {
      vi.spyOn(Date, "now").mockReturnValue(NOW);
      await i18n.setLocale(locale);
      await loadPlatformClawLocale();
      const published = {
        ...CURRENT,
        kind: "general",
        maintenanceAt: null,
        title: "Draft title",
        body: "Plain <script>text</script>",
      };
      const fetchImpl = mockServer({
        write: () => jsonResponse({ ...ACTIVE, current: published, announcement: published }),
      });
      const root = await ready(mount(fetchImpl));
      expect(root.querySelector(".launcher, openclaw-modal-dialog")).toBeNull();
      expect(button(root, "publish").textContent).toContain(locale === "ko" ? "게시" : "Publish");
      fill(root, "title", published.title);
      fill(root, "body", published.body);
      submit(root, preview);
      if (preview) {
        await vi.waitFor(() =>
          expect(root.querySelector(".preview")?.textContent).toContain("Draft title"),
        );
        expect(posts(fetchImpl)).toEqual([]);
        expect(root.querySelector("script")).toBeNull();
        button(root, "publish").click();
      }
      await vi.waitFor(() =>
        expect(root.querySelector("[role='status']")?.textContent).toContain(
          locale === "ko" ? "저장했습니다" : "Saved",
        ),
      );
      expect(posts(fetchImpl)).toEqual([
        {
          action: "publish",
          expectedRevision: 0,
          title: published.title,
          body: published.body,
          kind: "general",
          maintenanceAt: null,
          expiresAt: new Date(localTime(NOW + DAY)).getTime(),
        },
      ]);
      expect(root.querySelector(".preview, script")).toBeNull();
      expect(root.querySelector(".current")?.textContent).toContain(published.body);
      expect(root.querySelector<HTMLInputElement>("[name='title']")!.value).toBe("");
    },
  );

  it("initializes each new draft at click time and clears maintenance, preview and errors", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
    const root = await ready(mount(mockServer()));
    expect(root.querySelector<HTMLInputElement>("[name='expiresAt']")!.value).toBe(
      localTime(NOW + DAY),
    );
    await selectKind(root, "maintenance");
    expect(root.querySelector<HTMLInputElement>("[name='maintenanceAt']")!.value).toBe(
      localTime(NOW),
    );
    fill(root, "title", "Discard this");
    fill(root, "body", "Draft");
    submit(root, true);
    await vi.waitFor(() => expect(root.querySelector(".preview")).not.toBeNull());
    clock.mockReturnValue(NOW + 3_600_000);
    button(root, "new").click();
    await vi.waitFor(() => expect(root.querySelector(".preview")).toBeNull());
    expect(root.querySelector<HTMLInputElement>("[name='title']")!.value).toBe("");
    expect(root.querySelector<HTMLTextAreaElement>("[name='body']")!.value).toBe("");
    expect(root.querySelector<HTMLSelectElement>("[name='kind']")!.value).toBe("general");
    expect(root.querySelector<HTMLInputElement>("[name='expiresAt']")!.value).toBe(
      localTime(NOW + DAY + 3_600_000),
    );
    await selectKind(root, "maintenance");
    expect(root.querySelector<HTMLInputElement>("[name='maintenanceAt']")!.value).toBe(
      localTime(NOW + 3_600_000),
    );
    fill(root, "title", "Invalid times");
    fill(root, "body", "Draft");
    fill(root, "expiresAt", localTime(NOW));
    submit(root);
    await vi.waitFor(() => expect(root.querySelector("[role='alert']")).not.toBeNull());
    button(root, "new").click();
    await vi.waitFor(() =>
      expect(root.querySelector("[role='alert'], [role='status']")).toBeNull(),
    );
  });

  it.each(["active", "expired", "cancelled"])(
    "opens a blank draft when the latest notice is %s",
    async (state) => {
      vi.spyOn(Date, "now").mockReturnValue(NOW);
      const current = {
        ...CURRENT,
        cancelled: state === "cancelled",
        expiresAt: state === "expired" ? NOW - 60_000 : CURRENT.expiresAt,
      };
      const root = await ready(
        mount(
          mockServer({
            read: () =>
              jsonResponse({
                ...ACTIVE,
                current,
                announcement: state === "active" ? current : null,
              }),
          }),
        ),
      );
      expect(root.querySelector<HTMLInputElement>("[name='title']")!.value).toBe("");
      expect(root.querySelector<HTMLSelectElement>("[name='kind']")!.value).toBe("general");
      expect(root.querySelector<HTMLInputElement>("[name='expiresAt']")!.value).toBe(
        localTime(NOW + DAY),
      );
      expect(root.querySelector(".current")?.textContent).toContain(CURRENT.title);
      expect(Boolean(button(root, "edit-current"))).toBe(state !== "cancelled");
    },
  );

  it("edits the current notice explicitly and keeps the normalized update for further editing", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const normalized = { ...CURRENT, title: "Updated title", revision: 5 };
    const fetchImpl = mockServer({
      read: () => jsonResponse(ACTIVE),
      write: () =>
        jsonResponse({ ...ACTIVE, revision: 5, current: normalized, announcement: normalized }),
    });
    const root = await ready(mount(fetchImpl));
    button(root, "edit-current").click();
    await vi.waitFor(() => expect(button(root, "update")).not.toBeNull());
    expect(root.querySelector<HTMLInputElement>("[name='title']")!.value).toBe(CURRENT.title);
    expect(root.querySelector<HTMLInputElement>("[name='maintenanceAt']")!.value).toBe(
      localTime(CURRENT.maintenanceAt),
    );
    fill(root, "title", "  Updated title  ");
    submit(root);
    await vi.waitFor(() => expect(root.querySelector("[role='status']")).not.toBeNull());
    expect(posts(fetchImpl)[0]).toMatchObject({
      action: "update",
      expectedRevision: 4,
      title: "  Updated title  ",
    });
    expect(root.querySelector<HTMLInputElement>("[name='title']")!.value).toBe(normalized.title);
    expect(button(root, "update")).not.toBeNull();
    button(root, "new").click();
    await vi.waitFor(() => expect(button(root, "publish")).not.toBeNull());
    expect(root.querySelector<HTMLInputElement>("[name='title']")!.value).toBe("");
  });

  it("confirms cancellation without validating an unrelated unfinished draft", async () => {
    const cancelled = { ...CURRENT, cancelled: true, revision: 5 };
    const fetchImpl = mockServer({
      read: () => jsonResponse(ACTIVE),
      write: () => jsonResponse({ ...ACTIVE, revision: 5, current: cancelled, announcement: null }),
    });
    const root = await ready(mount(fetchImpl));
    button(root, "cancel").click();
    await vi.waitFor(() => expect(button(root, "cancel-confirm")).not.toBeNull());
    expect(posts(fetchImpl)).toEqual([]);
    button(root, "cancel-confirm").click();
    await vi.waitFor(() => expect(root.querySelector("[role='status']")).not.toBeNull());
    expect(posts(fetchImpl)).toEqual([{ action: "cancel", expectedRevision: 4 }]);
    expect(root.querySelector(".preview")).toBeNull();
    expect(root.querySelector<HTMLInputElement>("[name='title']")!.value).toBe("");
    expect(button(root, "edit-current")).toBeNull();
  });

  it.each([false, true])(
    "preserves a draft after a revision conflict (preview=%s)",
    async (preview) => {
      const fetchImpl = mockServer({
        write: () => jsonResponse({ error: "Announcement changed; reload" }, 409),
      });
      const root = await ready(mount(fetchImpl));
      fill(root, "title", "Keep my draft");
      fill(root, "body", "Message");
      submit(root, preview);
      if (preview) {
        await vi.waitFor(() => expect(root.querySelector(".preview")).not.toBeNull());
        button(root, "publish").click();
      }
      await vi.waitFor(() =>
        expect(root.querySelector("[role='alert']")?.textContent).toContain(
          "Announcement changed; reload",
        ),
      );
      if (preview) {
        expect(root.querySelector(".preview")?.textContent).toContain("Keep my draft");
      } else {
        expect(root.querySelector<HTMLInputElement>("[name='title']")!.value).toBe("Keep my draft");
      }
      expect(posts(fetchImpl)).toHaveLength(1);
    },
  );

  it.each(["past", "before-maintenance"])(
    "rejects an exposure end that is %s for preview and direct submission",
    async (invalid) => {
      vi.spyOn(Date, "now").mockReturnValue(NOW);
      const fetchImpl = mockServer();
      const root = await ready(mount(fetchImpl));
      fill(root, "title", "Invalid date");
      fill(root, "body", "Message");
      if (invalid === "before-maintenance") {
        await selectKind(root, "maintenance");
        fill(root, "maintenanceAt", localTime(NOW + DAY * 2));
      } else {
        fill(root, "expiresAt", localTime(NOW - 60_000));
      }
      submit(root, true);
      await vi.waitFor(() => expect(root.querySelector("[role='alert']")).not.toBeNull());
      expect(root.querySelector(".preview")).toBeNull();
      submit(root);
      await settle();
      expect(posts(fetchImpl)).toEqual([]);
    },
  );

  it("pages read-only history with plain text and honest legacy entries without changing the draft", async () => {
    await loadPlatformClawLocale();
    const cursor = { occurredAt: NOW, id: "audit-one" };
    const history = vi.fn((url: URL) =>
      jsonResponse(
        url.searchParams.has("cursor")
          ? {
              items: [{ ...HISTORY, id: "legacy", revision: 1, announcement: null }],
              nextCursor: null,
            }
          : {
              items: [
                {
                  ...HISTORY,
                  announcement: { ...CURRENT, body: "<script>history</script>\nFull text" },
                },
              ],
              nextCursor: cursor,
            },
      ),
    );
    const fetchImpl = mockServer({ history });
    const root = await ready(mount(fetchImpl));
    fill(root, "title", "Unpublished draft");
    await vi.waitFor(() => expect(root.querySelectorAll(".history details")).toHaveLength(1));
    const detail = root.querySelector<HTMLDetailsElement>(".history details")!;
    detail.open = true;
    expect(detail.querySelector(".body")?.textContent).toBe("<script>history</script>\nFull text");
    expect(detail.querySelector("script")).toBeNull();
    expect(detail.querySelector("time")?.dateTime).toBe(new Date(NOW).toISOString());
    button(root, "history-more").click();
    await vi.waitFor(() => expect(root.querySelectorAll(".history details")).toHaveLength(2));
    expect(JSON.parse(history.mock.calls[1]![0].searchParams.get("cursor")!)).toEqual(cursor);
    expect(root.querySelector(".history")?.textContent).toContain("content was not retained");
    expect(button(root, "history-more")).toBeNull();
    expect(root.querySelector<HTMLInputElement>("[name='title']")!.value).toBe("Unpublished draft");
    expect(posts(fetchImpl)).toEqual([]);
    expect(
      fetchImpl.mock.calls.every(
        ([, init]) => init?.credentials === "same-origin" && init.cache === "no-store",
      ),
    ).toBe(true);
  });

  it("keeps composition available while history is blocked and retries a failed page without losing earlier entries", async () => {
    const cursor = { occurredAt: NOW, id: HISTORY.id };
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    let reads = 0;
    const history = vi.fn(() => {
      reads++;
      return reads === 1
        ? pending
        : reads === 2
          ? jsonResponse({}, 503)
          : jsonResponse({ items: [{ ...HISTORY, id: "second" }], nextCursor: null });
    });
    const fetchImpl = mockServer({ history });
    const root = await ready(mount(fetchImpl));
    fill(root, "title", "History must not block me");
    release(jsonResponse({ items: [HISTORY], nextCursor: cursor }));
    await vi.waitFor(() => expect(button(root, "history-more")).not.toBeNull());
    button(root, "history-more").click();
    await vi.waitFor(() => expect(root.querySelector(".history [role='alert']")).not.toBeNull());
    expect(root.querySelectorAll(".history details")).toHaveLength(1);
    button(root, "history-retry").click();
    await vi.waitFor(() => expect(root.querySelectorAll(".history details")).toHaveLength(2));
    expect(root.querySelector(".history [role='alert']")).toBeNull();
    expect(root.querySelector<HTMLInputElement>("[name='title']")!.value).toBe(
      "History must not block me",
    );
  });

  it("ignores a history page superseded by a successful publish and retains the new compose state", async () => {
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    let reads = 0;
    const fetchImpl = mockServer({
      history: () =>
        ++reads === 1
          ? jsonResponse({ items: [HISTORY], nextCursor: { occurredAt: NOW, id: HISTORY.id } })
          : reads === 2
            ? pending
            : jsonResponse({
                items: [
                  { ...HISTORY, id: "fresh", announcement: { ...CURRENT, title: "Fresh history" } },
                ],
                nextCursor: null,
              }),
    });
    const root = await ready(mount(fetchImpl));
    await vi.waitFor(() => expect(button(root, "history-more")).not.toBeNull());
    button(root, "history-more").click();
    await vi.waitFor(() => expect(reads).toBe(2));
    fill(root, "title", "Publish while paging");
    fill(root, "body", "Message");
    submit(root);
    await vi.waitFor(() =>
      expect(root.querySelector(".history")?.textContent).toContain("Fresh history"),
    );
    fill(root, "title", "Next draft");
    release(
      jsonResponse({
        items: [{ ...HISTORY, id: "stale", announcement: { ...CURRENT, title: "Stale history" } }],
        nextCursor: null,
      }),
    );
    await settle();
    expect(root.querySelector(".history")?.textContent).not.toContain("Stale history");
    expect(root.querySelectorAll(".history details")).toHaveLength(1);
    expect(root.querySelector<HTMLInputElement>("[name='title']")!.value).toBe("Next draft");
    expect(root.querySelector("[role='status']")?.textContent).toContain("Saved");
  });

  it("keeps a reconnected page draft when an earlier connection's load and history finish last", async () => {
    let releaseRead!: (response: Response) => void;
    let releaseHistory!: (response: Response) => void;
    const pendingRead = new Promise<Response>((resolve) => {
      releaseRead = resolve;
    });
    const pendingHistory = new Promise<Response>((resolve) => {
      releaseHistory = resolve;
    });
    let reads = 0;
    let historyReads = 0;
    const fetchImpl = mockServer({
      read: () => (++reads === 1 ? pendingRead : jsonResponse(EMPTY)),
      history: () => (++historyReads === 1 ? pendingHistory : jsonResponse(EMPTY_HISTORY)),
    });
    const element = mount(fetchImpl);
    await vi.waitFor(() => expect(historyReads).toBe(1));
    element.remove();
    document.body.append(element);
    const root = await ready(element);
    fill(root, "title", "Keep my new draft");
    releaseRead(jsonResponse(ACTIVE));
    releaseHistory(jsonResponse({ items: [HISTORY], nextCursor: null }));
    await settle();
    expect(root.querySelector<HTMLInputElement>("[name='title']")!.value).toBe("Keep my new draft");
    expect(root.querySelectorAll(".history details")).toHaveLength(0);
    expect(root.querySelector(".current")).toBeNull();
  });

  it.each(["read", "write", "history"])(
    "ignores a retired page's %s authentication failure",
    async (path) => {
      let release!: (response: Response) => void;
      const pending = new Promise<Response>((resolve) => {
        release = resolve;
      });
      const fetchImpl = mockServer({ [path]: () => pending });
      const onUnauthenticated = vi.fn();
      const element = mount(fetchImpl, onUnauthenticated);
      if (path === "write") {
        const root = await ready(element);
        fill(root, "title", "Pending publish");
        fill(root, "body", "Message");
        submit(root);
        await vi.waitFor(() => expect(posts(fetchImpl)).toHaveLength(1));
      } else {
        await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
      }
      element.remove();
      release(jsonResponse({ error: "authentication required" }, 401));
      await settle();
      expect(onUnauthenticated).not.toHaveBeenCalled();
    },
  );
});
