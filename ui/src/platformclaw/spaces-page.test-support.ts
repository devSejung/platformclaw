import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, expect, vi } from "vitest";
import type { SpaceConversation } from "../../../packages/platformclaw-control-plane/src/space-contracts.js";
import { i18n } from "../i18n/index.ts";
import { loadAllPlatformClawLocales } from "./i18n.ts";
import "./spaces-page.ts";
export const space = {
  id: "work-a",
  name: "Mixed Signal Project",
  role: "owner",
  revision: 1,
  agentId: "space-one",
};
export const page = {
  id: "issue-a",
  spaceId: space.id,
  parentId: null,
  title: "Timing issue",
  body: "Shared notes",
  revision: 1,
  createdBy: "alice",
  updatedAt: 100,
};
export const member = { userId: "alice", accountId: "alice", displayName: "Alice", role: "owner" };
const roots: HTMLElement[] = [];
const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
export function setupSpacePageTests() {
  afterEach(() => {
    roots.splice(0).forEach((root) => root.remove());
    vi.restoreAllMocks();
    if (clipboardDescriptor) {
      Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
    } else {
      Reflect.deleteProperty(navigator, "clipboard");
    }
    history.replaceState(null, "", "/");
  });
  beforeEach(async () => {
    Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
    await i18n.setLocale("en");
    await loadAllPlatformClawLocales();
  });
}
type Element = HTMLElement & {
  context: unknown;
  routeSearch: string | undefined;
  requestUpdate: () => void;
  updateComplete: Promise<unknown>;
  selectSpace: (id: string) => Promise<void>;
  selectPage: (page: unknown) => void;
  refresh: (revalidate?: boolean) => Promise<void>;
};
export async function mount(role = "owner", conversations: SpaceConversation[] = []) {
  const listeners = new Set<(event: { event: string; payload?: unknown }) => void>();
  const request = vi.fn(
    async (method: string, _params?: Record<string, unknown>): Promise<unknown> => {
      if (method.endsWith(".list")) {
        return [{ ...space, role }];
      }
      if (method.endsWith(".get")) {
        return {
          space: { ...space, role },
          pages: [page],
          members: [member],
          conversations,
          currentUserId: "alice",
        };
      }
      if (method.endsWith(".history")) {
        return {
          messages: [
            {
              id: "m1",
              role: "user",
              text: "Earlier question",
              timestamp: 100,
              authorName: "Alice",
            },
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
    },
  );
  const gateway = {
    snapshot: { phase: "connected", client: { request } },
    subscribe: () => () => {},
    subscribeEvents: (fn: (event: { event: string; payload?: unknown }) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  const element = document.createElement("platformclaw-spaces-page") as Element;
  element.context = {
    gateway,
    replace: (_route: string, options: { search: string; hash: string }) => {
      history.replaceState(null, "", `${location.pathname}${options.search}${options.hash}`);
    },
  };
  document.body.append(element);
  roots.push(element);
  await element.updateComplete;
  await vi.waitFor(() => expect(request).toHaveBeenCalledWith("platformclaw.spaces.list", {}));
  await element.selectSpace(space.id);
  element.selectPage(page);
  await element.updateComplete;
  await vi.waitFor(() =>
    expect(element.querySelector('[role="tab"][aria-selected="true"]')).not.toBeNull(),
  );
  if (conversations.length === 0) {
    await vi.waitFor(() => expect(element.textContent).toContain("Earlier question"));
  }
  return {
    element,
    request,
    gateway,
    emit: (event: { event: string; payload?: unknown }) => listeners.forEach((fn) => fn(event)),
  };
}
export function button(element: HTMLElement, text: string) {
  const found = [...element.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === text || item.getAttribute("aria-label") === text,
  );
  expect(found, `button ${text}`).toBeDefined();
  return found!;
}
export async function beginEdit(element: Element) {
  if (
    ![...element.querySelectorAll("button")].some(
      (item) => item.textContent?.trim() === "Edit page",
    )
  ) {
    button(element, "Notes").click();
    await element.updateComplete;
  }
  button(element, "Edit page").click();
  await element.updateComplete;
}
export function input(element: HTMLElement, label: string, value: string) {
  const field = [...element.querySelectorAll("label")]
    .find((item) => item.textContent?.includes(label))
    ?.querySelector("input,textarea") as HTMLInputElement;
  expect(field).toBeDefined();
  field.value = value;
  field.dispatchEvent(new Event("input", { bubbles: true }));
}
