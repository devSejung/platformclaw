import { describe, expect, it, vi } from "vitest";
import type { SpaceConversation } from "../../../packages/platformclaw-control-plane/src/space-contracts.js";
import { member, mount, page, setupSpacePageTests, space } from "./spaces-page.test-support.ts";

setupSpacePageTests();

const own: SpaceConversation = {
  id: "own-conversation",
  spaceId: space.id,
  pageId: page.id,
  title: "Own investigation",
  ownerId: "alice",
  ownerName: "Alice",
  agentId: "alice",
  sessionKey: "agent:alice:space-session:12345678-90ab-cdef-1234-567890abcdef",
  createdAt: 1,
  canWrite: false,
};
const otherPage = { ...page, id: "second-issue", title: "Second issue" };
const other = {
  ...own,
  id: "second-conversation",
  pageId: otherPage.id,
  title: "Second investigation",
};
const snapshot = {
  space,
  pages: [page, otherPage],
  conversations: [own, other],
  members: [member],
  currentUserId: "alice",
};

function changeRoute(
  element: Awaited<ReturnType<typeof mount>>["element"],
  selected: SpaceConversation,
) {
  const search = `?space=${selected.spaceId}&page=${selected.pageId}&conversation=${selected.id}`;
  history.replaceState(null, "", `${location.pathname}${search}`);
  element.routeSearch = search;
}

describe("Space route selection lifetime", () => {
  it("keeps a newer offline selection through reconnect and ignores pending loader data", async () => {
    const { element, request, gateway } = await mount("viewer", [own]);
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (method, params) =>
      method.endsWith(".get") ? snapshot : original(method, params),
    );
    changeRoute(element, own);
    await element.updateComplete;
    const calls = request.mock.calls.length;
    element.routeSearch = undefined;
    await element.updateComplete;
    expect(element.querySelector(".pc-space-heading")?.textContent).toContain(page.title);
    expect(request.mock.calls).toHaveLength(calls);
    gateway.snapshot.phase = "reconnecting";
    changeRoute(element, other);
    // The route change retires its selection in updated(), which schedules
    // the render that removes the old heading before reconnect begins.
    await vi.waitFor(() =>
      expect(element.querySelector(".pc-space-heading")?.textContent).not.toContain(page.title),
    );
    expect(request.mock.calls).toHaveLength(calls);
    gateway.snapshot.phase = "connected";
    element.requestUpdate();
    await vi.waitFor(() =>
      expect(element.querySelector(".pc-space-heading")?.textContent).toContain(otherPage.title),
    );
    expect(new URLSearchParams(location.search).get("conversation")).toBe(other.id);
  });

  it("restores page and conversation on same-component back/forward navigation", async () => {
    const { element, request } = await mount("viewer", [own]);
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (method, params) =>
      method.endsWith(".get") ? snapshot : original(method, params),
    );
    for (const selected of [other, own, other]) {
      changeRoute(element, selected);
      await vi.waitFor(() =>
        expect(element.querySelector(".pc-space-heading")?.textContent).toContain(
          selected.pageId === page.id ? page.title : otherPage.title,
        ),
      );
      await vi.waitFor(() =>
        expect(
          element.querySelector<HTMLElement & { conversationId: string }>(
            "platformclaw-space-conversation-history",
          )?.conversationId,
        ).toBe(selected.id),
      );
      expect(element.querySelector("openclaw-chat-pane")).toBeNull();
    }
  });

  it("cannot restore an earlier page after a newer route wins", async () => {
    const { element, request } = await mount("viewer", [own]);
    const original = request.getMockImplementation()!;
    let release!: (value: typeof snapshot) => void;
    let pending = true;
    request.mockImplementation(async (method, params) => {
      if (method.endsWith(".get")) {
        if (pending) {
          pending = false;
          return new Promise((resolve) => {
            release = resolve;
          });
        }
        return snapshot;
      }
      return original(method, params);
    });
    changeRoute(element, other);
    await vi.waitFor(() => expect(release).toBeDefined());
    changeRoute(element, own);
    await vi.waitFor(() =>
      expect(element.querySelector(".pc-space-heading")?.textContent).toContain(page.title),
    );
    release(snapshot);
    await element.updateComplete;
    await Promise.resolve();
    expect(element.querySelector(".pc-space-heading")?.textContent).toContain(page.title);
    expect(new URLSearchParams(location.search).get("conversation")).toBe(own.id);
  });
});
