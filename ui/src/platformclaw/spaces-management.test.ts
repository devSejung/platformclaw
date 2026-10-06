import { describe, expect, it, vi } from "vitest";
import {
  button,
  input,
  member,
  mount,
  page,
  setupSpacePageTests,
  space,
} from "./spaces-page.test-support.ts";
setupSpacePageTests();
describe("Space management page workflows", () => {
  it.each(["owner", "editor", "viewer"])(
    "exposes self-leave to %s but deletion only to the owner",
    async (role) => {
      const { element, request } = await mount(role);
      button(element, "Members and access").click();
      await element.updateComplete;
      expect(button(element, "Leave Space").disabled).toBe(false);
      const deleteButton = [...element.querySelectorAll("button")].find(
        (item) => item.textContent?.trim() === "Delete Space",
      );
      expect(Boolean(deleteButton)).toBe(role === "owner");
      button(element, "Leave Space").click();
      await element.updateComplete;
      const modal = element.querySelector("openclaw-modal-dialog")!;
      expect(modal.textContent).toContain("shared questions and answers remain");
      button(modal, "Cancel").click();
      await element.updateComplete;
      expect(element.querySelector("openclaw-modal-dialog")).toBeNull();
      expect(request.mock.calls.some(([method]) => /\.(?:delete|leave)$/.test(method))).toBe(false);
    },
  );
  it.each(["delete", "leave"] as const)(
    "clears selected content, search, deep links and the sidebar after %s",
    async (kind) => {
      const { element, request } = await mount(kind === "delete" ? "owner" : "viewer");
      const original = request.getMockImplementation()!;
      let removed = false;
      request.mockImplementation(async (method, params) => {
        if (method === `platformclaw.spaces.${kind}`) {
          removed = true;
          return kind === "delete" ? { deleted: true } : { left: true };
        }
        if (method.endsWith(".list") && removed) {
          return [];
        }
        return original(method, params);
      });
      history.replaceState(
        null,
        "",
        `/?space=${space.id}&page=${page.id}&conversation=shared&message=m1`,
      );
      const search = element.querySelector<HTMLInputElement>("input[type=search]")!;
      search.value = "Previous project query";
      search.dispatchEvent(new Event("input", { bubbles: true }));
      button(element, "Members and access").click();
      await element.updateComplete;
      const label = kind === "delete" ? "Delete Space" : "Leave Space";
      button(element, label).click();
      await element.updateComplete;
      const modal = element.querySelector("openclaw-modal-dialog")!;
      if (kind === "delete") {
        input(modal, "Space name to confirm deletion", space.name);
      }
      button(modal, label).click();
      await vi.waitFor(() =>
        expect(request).toHaveBeenCalledWith(`platformclaw.spaces.${kind}`, {
          spaceId: space.id,
          expectedRevision: space.revision,
          ...(kind === "delete" ? { confirmName: space.name } : {}),
        }),
      );
      await vi.waitFor(() =>
        expect(element.textContent).toContain(
          kind === "delete" ? "Space deleted for all members." : "You left the Space.",
        ),
      );
      expect(element.textContent).not.toContain("Earlier question");
      expect(element.textContent).not.toContain(space.name);
      expect(element.querySelector(".pc-space-results")).toBeNull();
      expect(element.querySelector("openclaw-modal-dialog")).toBeNull();
      for (const key of ["space", "page", "conversation", "message"]) {
        expect(new URL(location.href).searchParams.has(key)).toBe(false);
      }
    },
  );
  it("hides content immediately during deletion invalidation and exposes retry after a cleanup failure", async () => {
    const { element, request, emit } = await mount();
    const original = request.getMockImplementation()!;
    let rejectDelete!: (error: Error) => void;
    let deleting = false;
    request.mockImplementation(async (method, params) => {
      if (method.endsWith(".delete")) {
        deleting = true;
        return new Promise((_resolve, reject) => {
          rejectDelete = reject;
        });
      }
      if (method.endsWith(".list") && deleting) {
        return [{ ...space, deleting: true }];
      }
      return original(method, params);
    });
    button(element, "Members and access").click();
    await element.updateComplete;
    button(element, "Delete Space").click();
    await element.updateComplete;
    const modal = element.querySelector("openclaw-modal-dialog")!;
    input(modal, "Space name to confirm deletion", space.name);
    button(modal, "Delete Space").click();
    await vi.waitFor(() => expect(rejectDelete).toBeDefined());
    emit({ event: "platformclaw.spaces.invalidated" });
    await element.updateComplete;
    expect(element.textContent).not.toContain("Earlier question");
    expect(element.querySelector("openclaw-chat-pane")).toBeNull();
    expect(element.querySelector("openclaw-modal-dialog")).not.toBeNull();
    const getCount = request.mock.calls.filter(([method]) => method.endsWith(".get")).length;
    rejectDelete(new Error("Stored data cleanup failed; retry deletion"));
    await vi.waitFor(() => expect(button(element, "Retry deletion").disabled).toBe(false));
    expect(element.querySelector('[role="alert"]')?.textContent).toContain("cleanup failed");
    expect(request.mock.calls.filter(([method]) => method.endsWith(".get"))).toHaveLength(getCount);
    expect(element.querySelector(".pc-space-group-title")).toBeNull();
    button(element, "Retry deletion").click();
    await element.updateComplete;
    expect(element.querySelector("openclaw-modal-dialog")?.textContent).toContain(space.name);
    expect(element.querySelector<HTMLInputElement>('[name="confirmName"]')?.value).toBe("");
  });
  it("retains the leave retry after membership removal when run cleanup fails", async () => {
    const { element, request, emit } = await mount("editor");
    const original = request.getMockImplementation()!;
    let rejectLeave!: (error: Error) => void;
    let left = false;
    request.mockImplementation(async (method, params) => {
      if (method.endsWith(".leave")) {
        left = true;
        return new Promise((_resolve, reject) => {
          rejectLeave = reject;
        });
      }
      if (method.endsWith(".list") && left) {
        return [];
      }
      return original(method, params);
    });
    button(element, "Members and access").click();
    await element.updateComplete;
    button(element, "Leave Space").click();
    await element.updateComplete;
    const modal = element.querySelector("openclaw-modal-dialog")!;
    button(modal, "Leave Space").click();
    await vi.waitFor(() => expect(rejectLeave).toBeDefined());
    emit({ event: "platformclaw.spaces.invalidated" });
    rejectLeave(new Error("Access removed; retry removal to finish cleanup"));
    await vi.waitFor(() =>
      expect(modal.querySelector('[role="alert"]')?.textContent).toContain("Access removed"),
    );
    await vi.waitFor(() => expect(element.querySelector(".pc-space-group")).toBeNull());
    expect(element.querySelector("openclaw-modal-dialog")).toBe(modal);
    expect(element.textContent).not.toContain("Earlier question");
    request.mockImplementation(async (method, params) =>
      method.endsWith(".leave")
        ? { left: true }
        : method.endsWith(".list")
          ? []
          : original(method, params),
    );
    button(modal, "Leave Space").click();
    await vi.waitFor(() => expect(element.querySelector("openclaw-modal-dialog")).toBeNull());
    expect(request.mock.calls.filter(([method]) => method.endsWith(".leave"))).toHaveLength(2);
    expect(new URL(location.href).searchParams.has("space")).toBe(false);
  });
  it("offers durable leave cleanup retry without requesting departed Space content", async () => {
    const { element, request } = await mount("editor");
    const original = request.getMockImplementation()!;
    let leaving = true;
    request.mockImplementation(async (method, params) => {
      if (method.endsWith(".list")) {
        return leaving ? [{ ...space, role: "editor", revision: 8, leaving: true }] : [];
      }
      if (method.endsWith(".leave")) {
        leaving = false;
        return { left: true };
      }
      return original(method, params);
    });
    const getCount = request.mock.calls.filter(([method]) => method.endsWith(".get")).length;
    await element.refresh();
    await element.updateComplete;
    expect(element.querySelector(".pc-space-group-title")).toBeNull();
    expect(element.textContent).not.toContain("Earlier question");
    expect(request.mock.calls.filter(([method]) => method.endsWith(".get"))).toHaveLength(getCount);
    button(element, "Retry leaving").click();
    await element.updateComplete;
    const modal = element.querySelector("openclaw-modal-dialog")!;
    button(modal, "Leave Space").click();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("platformclaw.spaces.leave", {
        spaceId: space.id,
        expectedRevision: 8,
      }),
    );
    await vi.waitFor(() => expect(element.querySelector(".pc-space-group")).toBeNull());
  });
  it("does not remount revoked content from a get started before the removal invalidation", async () => {
    const { element, request, emit } = await mount();
    const original = request.getMockImplementation()!;
    let releaseGet!: (value: unknown) => void;
    let releaseDelete!: (value: unknown) => void;
    let deleted = false;
    request.mockImplementation(async (method, params) => {
      if (method.endsWith(".get")) {
        return new Promise((resolve) => {
          releaseGet = resolve;
        });
      }
      if (method.endsWith(".delete")) {
        return new Promise((resolve) => {
          releaseDelete = resolve;
        });
      }
      if (method.endsWith(".list") && deleted) {
        return [];
      }
      return original(method, params);
    });
    button(element, "Members and access").click();
    await element.updateComplete;
    button(element, "Delete Space").click();
    await element.updateComplete;
    const modal = element.querySelector("openclaw-modal-dialog")!;
    input(modal, "Space name to confirm deletion", space.name);
    const refreshing = element.refresh(true);
    await vi.waitFor(() => expect(releaseGet).toBeDefined());
    button(modal, "Delete Space").click();
    await vi.waitFor(() => expect(releaseDelete).toBeDefined());
    emit({ event: "platformclaw.spaces.invalidated" });
    releaseGet({
      space,
      pages: [page],
      members: [member],
      conversations: [],
      currentUserId: "alice",
    });
    await refreshing;
    await element.updateComplete;
    expect(element.querySelector(".pc-space-conversation")).toBeNull();
    expect(element.textContent).not.toContain(page.title);
    expect(element.textContent).not.toContain("Earlier question");
    expect(element.querySelector("openclaw-modal-dialog")).toBe(modal);
    deleted = true;
    releaseDelete({ deleted: true });
    await vi.waitFor(() => expect(element.querySelector("openclaw-modal-dialog")).toBeNull());
  });
});
