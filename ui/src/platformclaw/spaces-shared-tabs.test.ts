import { describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import { loadPlatformClawLocale } from "./i18n.ts";
import type { SpaceQaPost } from "./space-qa-posts.ts";
import {
  mount,
  page,
  selectNotes,
  setupSpacePageTests,
  space,
} from "./spaces-page.test-support.ts";

setupSpacePageTests();
const post: SpaceQaPost = {
  id: "saved-one",
  spaceId: space.id,
  pageId: page.id,
  revision: 1,
  body: "**Reviewed answer**\n\n<script>unsafe()</script>\n\n![tracking](https://review.invalid/redacted-url-4)",
  authorId: "bob",
  authorName: "Bob Example",
  agentId: "personal-bob",
  createdAt: 100,
  bodyOffset: 0,
  nextBodyOffset: null,
  truncated: false,
};

describe("issue shared tabs", () => {
  it.each(["owner", "editor", "viewer"])(
    "shows shared notes directly to %s without executing",
    async (role) => {
      const { element, request } = await mount(role);
      const calls = request.mock.calls.length;
      await selectNotes(element);
      expect(element.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain(
        "Shared Notes",
      );
      expect(element.querySelector(".pc-space-notes")?.textContent).toContain("Shared notes");
      expect(element.querySelector(".pc-space-notes")?.textContent).toContain("All Space members");
      expect(Boolean(element.querySelector(".pc-space-note-actions"))).toBe(role !== "viewer");
      expect(element.querySelector(".pc-space-notes-trigger")).toBeNull();
      expect(element.querySelector("openclaw-chat-pane")).toBeNull();
      expect(request.mock.calls.slice(calls)).toEqual([]);
    },
  );

  it.each(["en", "ko"] as const)(
    "renders attributed saved posts beside preserved history in %s",
    async (locale) => {
      const { element, request } = await mount();
      await i18n.setLocale(locale);
      await loadPlatformClawLocale();
      const original = request.getMockImplementation()!;
      request.mockImplementation(async (method, params) =>
        method.endsWith("qa.list")
          ? { revision: 1, posts: [post], nextCursor: null }
          : original(method, params),
      );
      element.selectPage(page);
      await vi.waitFor(() =>
        expect(element.querySelector(".pc-space-qa-post strong")?.textContent).toBe(
          post.authorName,
        ),
      );
      expect(element.querySelector(".pc-space-qa-post")?.textContent).toContain(
        locale === "ko" ? "에이전트가 대신 저장" : "Saved by their agent",
      );
      expect(element.querySelector(".pc-space-qa-post time")?.getAttribute("datetime")).toBe(
        new Date(100).toISOString(),
      );
      expect(element.querySelector(".pc-space-qa-post .markdown-content strong")?.textContent).toBe(
        "Reviewed answer",
      );
      expect(element.querySelector(".pc-space-qa-post script")).toBeNull();
      expect(element.querySelector(".pc-space-qa-post img")).toBeNull();
      expect(element.textContent).toContain("Earlier question");
      expect(element.querySelector(".pc-space-conversation textarea")).toBeNull();
      expect(request.mock.calls.some(([method]) => /(?:send|create|abort)$/.test(method))).toBe(
        false,
      );
    },
  );

  it("opens a saved-post source and keeps its anchor after invalidation", async () => {
    const { element, request, emit } = await mount();
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (method, params) =>
      method.endsWith("qa.get") ? { revision: 1, post } : original(method, params),
    );
    const search = `?space=${space.id}&page=${page.id}&tab=qa&post=${post.id}`;
    history.replaceState(null, "", `/${search}`);
    element.routeSearch = search;
    await vi.waitFor(() =>
      expect(element.querySelector(`[id="post-${post.id}"]`)?.getAttribute("data-source")).toBe(
        "true",
      ),
    );
    emit({ event: "platformclaw.spaces.invalidated" });
    await vi.waitFor(() =>
      expect(request.mock.calls.filter(([method]) => method.endsWith("qa.get"))).toHaveLength(2),
    );
    await vi.waitFor(() => expect(element.textContent).toContain("Reviewed answer"));
    expect(new URL(location.href).searchParams.get("post")).toBe(post.id);
    expect(element.querySelector("openclaw-chat-pane")).toBeNull();
  });

  it("preserves the notes tab and shared body across refresh, reconnect and back navigation", async () => {
    const { element, gateway, emit } = await mount();
    await selectNotes(element);
    emit({ event: "platformclaw.spaces.invalidated" });
    await vi.waitFor(() =>
      expect(element.querySelector(".pc-space-notes")?.textContent).toContain("Shared notes"),
    );
    gateway.snapshot.phase = "reconnecting";
    element.requestUpdate();
    await vi.waitFor(() => expect(element.querySelector(".pc-space-notes")).toBeNull());
    gateway.snapshot.phase = "connected";
    element.requestUpdate();
    await vi.waitFor(() =>
      expect(element.querySelector(".pc-space-notes")?.textContent).toContain("Shared notes"),
    );
    for (const tab of ["qa", "notes"]) {
      const search = `?space=${space.id}&page=${page.id}&tab=${tab}`;
      history.replaceState(null, "", `/${search}`);
      element.routeSearch = search;
      await vi.waitFor(() =>
        expect(element.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain(
          tab === "notes" ? "Shared Notes" : "Shared Q&A",
        ),
      );
    }
  });

  it("never renders a revoked identity's pending post list", async () => {
    const { element, request, gateway } = await mount();
    const original = request.getMockImplementation()!;
    let release!: (value: unknown) => void;
    request.mockImplementation(async (method, params) =>
      method.endsWith("qa.list")
        ? new Promise((resolve) => {
            release = resolve;
          })
        : original(method, params),
    );
    element.selectPage(page);
    await vi.waitFor(() => expect(release).toBeDefined());
    gateway.snapshot.client = { request: vi.fn(async () => []) };
    gateway.snapshot.phase = "stopped";
    element.requestUpdate();
    release({ revision: 1, posts: [post], nextCursor: null });
    await element.updateComplete;
    await Promise.resolve();
    expect(element.textContent).not.toContain("Reviewed answer");
    expect(element.querySelector(".pc-space-qa-post")).toBeNull();
    expect(element.querySelector(".pc-space-notes")).toBeNull();
  });
});
