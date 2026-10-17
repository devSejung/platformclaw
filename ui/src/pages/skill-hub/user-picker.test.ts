/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import "./user-picker.ts";

const employees = [
  { id: "directory-id-one", accountId: "alex.one", displayName: "Alex" },
  { id: "directory-id-two", accountId: "alex.two", displayName: "Alex" },
];
const response = (items = employees) => new Response(JSON.stringify({ items }));

async function fixture(purpose: "owner" | "access" = "owner") {
  const picker = document.createElement("openclaw-skill-hub-user-picker");
  picker.namespace = "engineering";
  picker.slug = "demo";
  picker.purpose = purpose;
  picker.onSelect = vi.fn();
  document.body.append(picker);
  await picker.updateComplete;
  const input = picker.querySelector("input")!;
  const type = async (value: string, isComposing = false) => {
    input.value = value;
    input.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing }));
    await picker.updateComplete;
  };
  const key = async (value: string) => {
    const event = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true });
    input.dispatchEvent(event);
    await picker.updateComplete;
    return event;
  };
  const load = async () => {
    await vi.advanceTimersByTimeAsync(250);
    await picker.updateComplete;
  };
  return { picker, input, type, key, load };
}

describe("Skill Hub employee autocomplete", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
    vi.useFakeTimers();
  });
  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each(["owner", "access"] as const)(
    "selects the exact %s employee by keyboard, clears selection on edits, and disables while busy",
    async (purpose) => {
      const fetch = vi.fn(async () => response());
      vi.stubGlobal("fetch", fetch);
      const { picker, input, type, key, load } = await fixture(purpose);
      await type("al");
      expect(picker.textContent).toContain("Searching");
      expect(fetch).not.toHaveBeenCalled();
      await load();
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining(`q=al&purpose=${purpose}&limit=20`),
        expect.any(Object),
      );
      expect(input.getAttribute("aria-expanded")).toBe("true");
      expect(picker.querySelectorAll('[role="option"]')).toHaveLength(2);
      await key("ArrowDown");
      await key("ArrowDown");
      expect(input.getAttribute("aria-activedescendant")).toBe(`skill-hub-${purpose}-users-1`);
      await key("Enter");
      expect(picker.onSelect).toHaveBeenLastCalledWith(employees[1]);
      expect(input.value).toBe("Alex (alex.two)");
      expect(input.getAttribute("aria-expanded")).toBe("false");
      await type("Alex");
      expect(picker.onSelect).toHaveBeenLastCalledWith(null);
      await load();
      picker.disabled = true;
      await picker.updateComplete;
      expect(input.disabled).toBe(true);
      expect(picker.querySelector<HTMLButtonElement>('[role="option"]')?.disabled).toBe(true);
      await key("ArrowDown");
      await key("Enter");
      expect(picker.onSelect).toHaveBeenLastCalledWith(null);
    },
  );

  it("invalidates candidates immediately, including A-B-A queries and a changed skill", async () => {
    const pending: Array<(value: Response) => void> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            pending.push(resolve);
          }),
      ),
    );
    const { picker, input, type, load } = await fixture();
    await type("alex");
    await load();
    await type("bob");
    await load();
    await type("alex");
    await load();
    pending[0]!(response());
    await vi.advanceTimersByTimeAsync(0);
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(picker.querySelectorAll('[role="option"]')).toHaveLength(0);
    pending[2]!(response());
    await vi.advanceTimersByTimeAsync(0);
    expect(picker.querySelectorAll('[role="option"]')).toHaveLength(2);
    await type("a");
    expect(picker.querySelectorAll('[role="option"]')).toHaveLength(0);
    await type("bob");
    await load();
    picker.slug = "other-skill";
    await picker.updateComplete;
    pending[3]!(response());
    await vi.advanceTimersByTimeAsync(0);
    expect(input.value).toBe("");
    expect(picker.querySelectorAll('[role="option"]')).toHaveLength(0);
    pending[1]!(new Response(JSON.stringify({ error: "Old query failed" }), { status: 503 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(picker.textContent).not.toContain("Old query failed");
  });

  it("reports empty and failed searches inline and retries on the next query", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Directory unavailable" }), { status: 503 }),
      )
      .mockResolvedValueOnce(response());
    vi.stubGlobal("fetch", fetch);
    const { picker, type, load } = await fixture();
    await type("nobody");
    await load();
    expect(picker.querySelector('[role="status"]')?.textContent).toContain("No eligible employees");
    await type("alex");
    await load();
    expect(picker.querySelector('[role="alert"]')?.textContent).toContain("Directory unavailable");
    await type("alex.two");
    await load();
    expect(picker.querySelector('[role="alert"]')).toBeNull();
    expect(picker.querySelectorAll('[role="option"]')).toHaveLength(2);
  });

  it("waits for IME completion and lets Escape dismiss suggestions before the modal", async () => {
    const fetch = vi.fn(async () => response());
    vi.stubGlobal("fetch", fetch);
    const { picker, input, type, key, load } = await fixture();
    const parentKeydown = vi.fn();
    document.body.addEventListener("keydown", parentKeydown);
    try {
      await type("김직원", true);
      await load();
      expect(fetch).not.toHaveBeenCalled();
      input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      await load();
      await key("ArrowUp");
      expect(input.getAttribute("aria-activedescendant")).toBe("skill-hub-owner-users-1");
      parentKeydown.mockClear();
      await key("Escape");
      expect(parentKeydown).not.toHaveBeenCalled();
      expect(input.getAttribute("aria-expanded")).toBe("false");
      await key("Escape");
      expect(parentKeydown).toHaveBeenCalledOnce();
      await type("alex");
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
      await load();
      expect(picker.querySelectorAll('[role="option"]')).toHaveLength(0);
    } finally {
      document.body.removeEventListener("keydown", parentKeydown);
    }
  });

  it.each(["empty", "failed"])(
    "lets the first Escape reach the modal after a %s search",
    async (outcome) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          outcome === "empty"
            ? response([])
            : new Response(JSON.stringify({ error: "Directory unavailable" }), { status: 503 }),
        ),
      );
      const { picker, input, type, key, load } = await fixture();
      await type("alex");
      await load();
      expect(input.getAttribute("aria-expanded")).toBe("false");
      expect(picker.querySelector('[role="listbox"]')?.hasAttribute("hidden")).toBe(true);
      const parentKeydown = vi.fn();
      document.body.addEventListener("keydown", parentKeydown);
      try {
        const escape = await key("Escape");
        expect(parentKeydown).toHaveBeenCalledOnce();
        expect(escape.defaultPrevented).toBe(false);
      } finally {
        document.body.removeEventListener("keydown", parentKeydown);
      }
    },
  );
});
