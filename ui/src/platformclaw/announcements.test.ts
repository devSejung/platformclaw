/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import { PlatformClawAnnouncements } from "./announcements.ts";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

function snapshot() {
  const now = Date.now();
  return {
    revision: 1,
    serverNow: now,
    announcement: {
      id: "maintenance",
      revision: 1,
      title: "Scheduled maintenance",
      body: "Existing work continues.",
      kind: "maintenance",
      maintenanceAt: now + 60_000,
      expiresAt: now + 3_600_000,
    },
  };
}

function mount(fetchImpl: typeof fetch, deferAutomatic: boolean) {
  const element = document.createElement("platformclaw-announcements") as PlatformClawAnnouncements;
  element.fetchImpl = fetchImpl;
  element.deferAutomatic = deferAutomatic;
  document.body.append(element);
  return element;
}

describe("announcement automatic presentation deferral", () => {
  let restoreDialog: () => void;
  beforeEach(() => {
    restoreDialog = installDialogPolyfill();
  });
  afterEach(() => {
    document.querySelector("platformclaw-announcements")?.remove();
    restoreDialog();
  });

  it("keeps the banner visible without claiming a popup until administration ends", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(snapshot()))
      .mockResolvedValueOnce(jsonResponse({ show: true }));
    const element = mount(fetchImpl, true);
    const root = element.shadowRoot!;
    await vi.waitFor(() =>
      expect(root.querySelector("aside")?.textContent).toContain("Scheduled maintenance"),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(root.querySelector("openclaw-modal-dialog")).toBeNull();

    element.deferAutomatic = false;

    await vi.waitFor(() => expect(root.querySelector("openclaw-modal-dialog")).not.toBeNull());
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1]).toEqual([
      "/platformclaw/api/announcements/seen",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ id: "maintenance", revision: 1 }),
      }),
    ]);
    element.deferAutomatic = true;
    await element.updateComplete;
    element.deferAutomatic = false;
    await element.updateComplete;
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("allows manual viewing while automatic presentation is deferred", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(snapshot()));
    const element = mount(fetchImpl, true);
    const root = element.shadowRoot!;
    await vi.waitFor(() =>
      expect(root.querySelector("#announcement-content > button")).not.toBeNull(),
    );
    root.querySelector<HTMLButtonElement>("#announcement-content > button")!.click();
    await vi.waitFor(() =>
      expect(root.querySelector("openclaw-modal-dialog")?.textContent).toContain(
        "Existing work continues.",
      ),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(["general", "maintenance"] as const)(
    "hides the entire %s notice and restores it without claiming a popup",
    async (kind) => {
      const current = snapshot();
      current.announcement.kind = kind;
      if (kind === "general") {
        Object.assign(current.announcement, { maintenanceAt: null });
      }
      const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(current));
      const element = mount(fetchImpl, true);
      const root = element.shadowRoot!;
      await vi.waitFor(() => expect(root.querySelector("aside")).not.toBeNull());
      const button = root.querySelector<HTMLButtonElement>("[aria-controls]")!;
      const content = root.querySelector<HTMLElement>("#announcement-content")!;
      const title = root.querySelector<HTMLElement>("aside strong")!;
      expect(button.getAttribute("aria-expanded")).toBe("true");
      button.focus();
      for (const collapsed of [true, false, true, false]) {
        button.click();
        await element.updateComplete;
        expect(content.hidden).toBe(collapsed);
        expect(title.hidden).toBe(collapsed);
        expect(element.hasAttribute("data-active")).toBe(!collapsed);
        expect(root.activeElement).toBe(button);
        expect(button.getAttribute("aria-expanded")).toBe(String(!collapsed));
        expect(root.querySelector("aside strong")?.textContent).toBe(current.announcement.title);
        expect(Boolean(root.querySelector(".countdown"))).toBe(kind === "maintenance");
      }
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      if (kind === "maintenance") {
        root.querySelector<HTMLButtonElement>("#announcement-content > button")!.click();
        await element.updateComplete;
        expect(root.querySelector("openclaw-modal-dialog .body")?.textContent).toBe(
          current.announcement.body,
        );
        root.querySelector<HTMLButtonElement>(".panel button")!.click();
        await element.updateComplete;
        expect(content.hidden).toBe(false);
      }
    },
  );

  it("retains collapse through polling and reconnection, then expands edited or replaced notices", async () => {
    const current = snapshot();
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(current));
    const element = mount(fetchImpl, true);
    const root = element.shadowRoot!;
    await vi.waitFor(() => expect(root.querySelector("aside")).not.toBeNull());
    const button = root.querySelector<HTMLButtonElement>("[aria-controls]")!;
    button.click();
    await element.updateComplete;
    await element.refresh();
    await element.updateComplete;
    expect(root.querySelector<HTMLElement>("#announcement-content")!.hidden).toBe(true);
    element.remove();
    document.body.append(element);
    await element.refresh();
    await element.updateComplete;
    expect(root.querySelector<HTMLElement>("#announcement-content")!.hidden).toBe(true);
    current.revision++;
    current.announcement.revision++;
    current.announcement.body = "Updated notice";
    await element.refresh();
    await vi.waitFor(() =>
      expect(root.querySelector("#announcement-content .body")?.textContent).toBe("Updated notice"),
    );
    expect(root.querySelector<HTMLElement>("#announcement-content")!.hidden).toBe(false);
    button.click();
    await element.updateComplete;
    current.revision++;
    current.announcement.id = "replacement";
    current.announcement.title = "Replacement notice";
    await element.refresh();
    await vi.waitFor(() =>
      expect(root.querySelector("aside strong")?.textContent).toBe("Replacement notice"),
    );
    expect(root.querySelector<HTMLElement>("#announcement-content")!.hidden).toBe(false);
  });

  it("holds an already claimed popup through administration and resumes it without another claim", async () => {
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>((complete) => {
      resolve = complete;
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(snapshot()))
      .mockReturnValueOnce(pending);
    const element = mount(fetchImpl, false);
    const root = element.shadowRoot!;
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    element.deferAutomatic = true;
    await element.updateComplete;
    resolve(jsonResponse({ show: true }));
    await new Promise<void>((complete) => {
      setTimeout(complete, 0);
    });
    expect(root.querySelector("openclaw-modal-dialog")).toBeNull();

    element.deferAutomatic = false;

    await vi.waitFor(() => expect(root.querySelector("openclaw-modal-dialog")).not.toBeNull());
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
