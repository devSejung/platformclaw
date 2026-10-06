import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Space,
  SpaceConversation,
} from "../../../packages/platformclaw-control-plane/src/space-contracts.js";
import { i18n } from "../i18n/index.ts";
import { loadAllPlatformClawLocales } from "./i18n.ts";
import { renderSpaceManagementDialog, SpaceManagementState } from "./space-management.ts";

const space: Space = {
  id: "space-a",
  name: "Timing project",
  role: "owner",
  revision: 7,
  agentId: "space-agent",
};
const conversation: SpaceConversation = {
  id: "conversation-a",
  spaceId: space.id,
  pageId: "page-a",
  title: "Investigation",
  ownerId: "alice",
  ownerName: "Alice",
  agentId: "alice-agent",
  sessionKey: "agent:alice-agent:space-session:00000000-0000-4000-8000-000000000001",
  createdAt: 100,
  canWrite: true,
};
const roots: HTMLElement[] = [];
beforeEach(async () => {
  await i18n.setLocale("en");
  await loadAllPlatformClawLocales();
});
afterEach(() => {
  roots.splice(0).forEach((root) => root.remove());
  vi.restoreAllMocks();
});

function mount(state: SpaceManagementState, onSubmit = vi.fn()) {
  const root = document.createElement("div");
  document.body.append(root);
  roots.push(root);
  render(renderSpaceManagementDialog({ state, onSubmit }), root);
  return root;
}

describe("Space management confirmations", () => {
  it.each(["rename", "delete", "leave"] as const)(
    "pins %s target and revision and blocks duplicate pending submissions",
    async (kind) => {
      const state = new SpaceManagementState(vi.fn());
      state.open(kind === "rename" ? { kind, space, conversation } : { kind, space });
      let release!: (value: unknown) => void;
      const request = vi.fn(
        () =>
          new Promise<unknown>((resolve) => {
            release = resolve;
          }),
      );
      const completed = vi.fn();
      const value = kind === "rename" ? "  Revised title  " : kind === "delete" ? space.name : "";
      const submit = state.submit(value, request as Parameters<typeof state.submit>[1], completed);
      await state.submit(value, request as Parameters<typeof state.submit>[1], completed);
      expect(request).toHaveBeenCalledExactlyOnceWith(
        kind === "rename" ? "conversation.rename" : kind,
        {
          spaceId: space.id,
          expectedRevision: 7,
          ...(kind === "rename"
            ? {
                conversationId: conversation.id,
                expectedTitle: conversation.title,
                title: "Revised title",
              }
            : {}),
          ...(kind === "delete" ? { confirmName: space.name } : {}),
        },
      );
      expect(state.busy).toBe(true);
      release(kind === "rename" ? { ...conversation, title: "Revised title" } : { updated: true });
      expect(await submit).toBe("completed");
      expect(state.busy).toBe(false);
      expect(state.pending).toBeNull();
      expect(completed).toHaveBeenCalledOnce();
    },
  );

  it.each(["delete", "rename"] as const)(
    "rejects invalid %s confirmation without a request",
    async (kind) => {
      const state = new SpaceManagementState(vi.fn());
      state.open(kind === "rename" ? { kind, space, conversation } : { kind, space });
      const request = vi.fn();
      for (const value of kind === "delete"
        ? ["", "Timing", ` ${space.name}`, space.name.toLowerCase()]
        : ["", "  "]) {
        await state.submit(value, request, vi.fn());
      }
      expect(request).not.toHaveBeenCalled();
      expect(state.pending).not.toBeNull();
    },
  );

  it.each([false, true])(
    "ignores late %s response after navigation or identity loss",
    async (reject) => {
      const state = new SpaceManagementState(vi.fn());
      state.open({ kind: "delete", space });
      let settle!: () => void;
      const request = vi.fn(
        () =>
          new Promise<unknown>((resolve, fail) => {
            settle = () =>
              reject ? fail(new Error("Old request failure")) : resolve({ deleted: true });
          }),
      );
      const completed = vi.fn();
      const submit = state.submit(
        space.name,
        request as Parameters<typeof state.submit>[1],
        completed,
      );
      state.clear();
      settle();
      await submit;
      expect(completed).not.toHaveBeenCalled();
      expect(state.error).toBe("");
      expect(state.pending).toBeNull();
      expect(state.busy).toBe(false);
    },
  );

  it("keeps stale revision failures reviewable and retains the original confirmation on retry", async () => {
    const state = new SpaceManagementState(vi.fn());
    const action = { kind: "rename" as const, space, conversation };
    state.open(action);
    const request = vi.fn().mockRejectedValue(new Error("Space changed; reload before retrying"));
    await state.submit("Draft title", request, vi.fn());
    expect(state.pending).toBe(action);
    expect(state.error).toContain("reload before retrying");
    await state.submit("Draft title", request, vi.fn());
    expect(request.mock.calls[1]).toEqual(request.mock.calls[0]);
    const root = mount(state);
    expect(root.querySelector('[role="alert"]')?.textContent).toContain("Space changed");
    expect(root.textContent).toContain("cancel and refresh");
  });

  it.each(["rename", "delete", "leave"] as const)(
    "cancels %s through modal dismissal and blocks dismissal while submitting",
    async (kind) => {
      const state = new SpaceManagementState(vi.fn());
      state.open(kind === "rename" ? { kind, space, conversation } : { kind, space });
      const root = mount(state);
      const modal = root.querySelector("openclaw-modal-dialog")!;
      state.busy = true;
      expect(modal.dispatchEvent(new CustomEvent("modal-cancel", { cancelable: true }))).toBe(
        false,
      );
      expect(state.pending).not.toBeNull();
      state.busy = false;
      expect(modal.dispatchEvent(new CustomEvent("modal-cancel", { cancelable: true }))).toBe(true);
      expect(state.pending).toBeNull();
    },
  );

  it("requires the exact delete name in the form and explains actual irreversible scope", () => {
    const state = new SpaceManagementState(vi.fn());
    state.open({ kind: "delete", space });
    const onSubmit = vi.fn();
    const root = mount(state, onSubmit);
    const field = root.querySelector<HTMLInputElement>("input")!;
    const form = root.querySelector("form")!;
    expect(root.textContent).toContain(
      "permanently deletes the Space, its pages and identifiable conversation records",
    );
    expect(root.textContent).toContain("All members lose access");
    expect(root.textContent).toContain("cannot be undone");
    expect(root.textContent).toContain("external backups may remain");
    field.value = "Timing";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(onSubmit).not.toHaveBeenCalled();
    field.value = space.name;
    field.dispatchEvent(new Event("input", { bubbles: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(space.name);
  });

  it("allows the full 240-character conversation title contract", () => {
    const state = new SpaceManagementState(vi.fn());
    state.open({ kind: "rename", space, conversation });
    const onSubmit = vi.fn();
    const root = mount(state, onSubmit);
    const field = root.querySelector<HTMLInputElement>("input")!;
    expect(field.maxLength).toBe(240);
    field.value = "A".repeat(240);
    root
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith("A".repeat(240));
  });

  it("explains shared Q&A retention and last-owner handoff before leaving", () => {
    const state = new SpaceManagementState(vi.fn());
    state.open({ kind: "leave", space });
    const root = mount(state);
    expect(root.textContent).toContain("shared questions and answers remain");
    expect(root.textContent).toContain("make another member an owner");
  });
});
