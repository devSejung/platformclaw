import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import { loadAllPlatformClawLocales } from "./i18n.ts";
import "./spaces-page.ts";
const space = {
  id: "work-a",
  name: "Mixed Signal Project",
  role: "owner",
  revision: 1,
  agentId: "space-one",
};
const page = {
  id: "issue-a",
  spaceId: space.id,
  parentId: null,
  title: "Timing issue",
  body: "Shared notes",
  revision: 1,
  createdBy: "alice",
  updatedAt: 100,
};
const member = { userId: "alice", accountId: "alice", displayName: "Alice", role: "owner" };
const roots: HTMLElement[] = [];
afterEach(() => {
  roots.splice(0).forEach((root) => root.remove());
  vi.restoreAllMocks();
  history.replaceState(null, "", "/");
});
beforeEach(async () => {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
  await i18n.setLocale("en");
  await loadAllPlatformClawLocales();
});
type Element = HTMLElement & {
  context: unknown;
  updateComplete: Promise<unknown>;
  selectSpace: (id: string) => Promise<void>;
  selectPage: (page: unknown) => void;
  refresh: () => Promise<void>;
};
async function mount(role = "owner") {
  const listeners = new Set<(event: { event: string; payload?: unknown }) => void>();
  const request = vi.fn(async (method: string): Promise<unknown> => {
    if (method.endsWith(".list")) {
      return [{ ...space, role }];
    }
    if (method.endsWith(".get")) {
      return { space: { ...space, role }, pages: [page], members: [member] };
    }
    if (method.endsWith(".history")) {
      return {
        messages: [
          { id: "m1", role: "user", text: "Earlier question", timestamp: 100, authorName: "Alice" },
        ],
      };
    }
    if (method.endsWith(".people")) {
      return [{ userId: "bob", accountId: "bob", displayName: "Bob" }];
    }
    if (method.endsWith(".search")) {
      return { results: [] };
    }
    return { updated: true };
  });
  const gateway = {
    snapshot: { phase: "connected", client: { request } },
    subscribe: () => () => {},
    subscribeEvents: (fn: (event: { event: string; payload?: unknown }) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  const element = document.createElement("platformclaw-spaces-page") as Element;
  element.context = { gateway };
  document.body.append(element);
  roots.push(element);
  await element.updateComplete;
  await vi.waitFor(() => expect(request).toHaveBeenCalledWith("platformclaw.spaces.list", {}));
  await element.selectSpace(space.id);
  element.selectPage(page);
  await element.updateComplete;
  await vi.waitFor(() => expect(element.textContent).toContain("Earlier question"));
  return {
    element,
    request,
    gateway,
    emit: (event: { event: string; payload?: unknown }) => listeners.forEach((fn) => fn(event)),
  };
}
function button(element: HTMLElement, text: string) {
  const found = [...element.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === text,
  );
  expect(found, `button ${text}`).toBeDefined();
  return found!;
}
function input(element: HTMLElement, label: string, value: string) {
  const field = [...element.querySelectorAll("label")]
    .find((item) => item.textContent?.includes(label))
    ?.querySelector("input,textarea") as HTMLInputElement;
  expect(field).toBeDefined();
  field.value = value;
  field.dispatchEvent(new Event("input", { bubbles: true }));
}
describe("Space issue page UX", () => {
  it("shows per-issue shared context and cancels page edits without mutation", async () => {
    const { element, request } = await mount();
    expect(element.textContent).toContain("all Space members");
    expect(element.textContent).toContain("Shared notes");
    button(element, "Edit page").click();
    await element.updateComplete;
    input(element, "Title", "Unsaved");
    button(element, "Cancel").click();
    await element.updateComplete;
    expect(element.textContent).toContain("Timing issue");
    expect(request.mock.calls.some(([method]) => method.endsWith("page.save"))).toBe(false);
  });
  it("keeps viewers read-only and clears content after membership loss", async () => {
    const { element, request, emit } = await mount("viewer");
    expect(
      [...element.querySelectorAll("button")].some(
        (item) => item.textContent?.trim() === "Send to Space",
      ),
    ).toBe(false);
    request.mockImplementation(async (method: string) =>
      method.endsWith(".list") ? [] : Promise.reject(new Error("Space unavailable")),
    );
    emit({ event: "platformclaw.spaces.invalidated", payload: {} });
    await vi.waitFor(() => expect(element.textContent).not.toContain("Earlier question"));
    expect(element.textContent).toContain("no longer available");
  });
  it("requires visible employee confirmation before inviting and lets the user cancel", async () => {
    const { element, request } = await mount();
    button(element, "Members and access").click();
    await element.updateComplete;
    input(element, "Exact employee account ID", "bob");
    button(element, "Find employee").click();
    await vi.waitFor(() => expect(element.textContent).toContain("Invite Bob"));
    button(element, "Invite Bob (bob)").click();
    await element.updateComplete;
    expect(element.textContent).toContain("existing and future");
    button(element, "Cancel").click();
    await element.updateComplete;
    expect(request.mock.calls.some(([method]) => method.endsWith("member.set"))).toBe(false);
  });
  it("does not render a retired browser identity's late history response", async () => {
    const { element, request, gateway } = await mount();
    let release!: (value: unknown) => void;
    request.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          release = resolve;
        }),
    );
    element.selectPage(page);
    await element.updateComplete;
    gateway.snapshot.client = { request: vi.fn(async () => []) };
    gateway.snapshot.phase = "stopped";
    release({ messages: [{ id: "m2", role: "assistant", text: "Old identity secret" }] });
    await element.updateComplete;
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(element.textContent).not.toContain("Old identity secret");
  });
  it("keeps the committed role selected after cancelling a role change", async () => {
    const { element, request } = await mount();
    button(element, "Members and access").click();
    await element.updateComplete;
    const select = element.querySelector<HTMLSelectElement>("select")!;
    expect(select.value).toBe("owner");
    select.value = "viewer";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await element.updateComplete;
    button(element, "Cancel").click();
    await element.updateComplete;
    expect(select.value).toBe("owner");
    expect(request.mock.calls.some(([method]) => method.endsWith("member.set"))).toBe(false);
  });
  it("offers a root issue even when another issue is selected", async () => {
    const { element } = await mount();
    expect(button(element, "New issue page")).toBeDefined();
    expect(button(element, "New child issue")).toBeDefined();
  });
});
