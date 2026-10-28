/* @vitest-environment jsdom */
import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { loadAllPlatformClawLocales } from "../../platformclaw/i18n.ts";
import {
  renderSkillHubDelete,
  renderSkillHubNotifications,
  renderSkillHubVersionChange,
} from "./dialogs.ts";

afterEach(() => i18n.setLocale("en"));

describe("Skill Hub mutation confirmation", () => {
  it("localizes a confirmed-malware notification and preserves unfamiliar notifications", async () => {
    await loadAllPlatformClawLocales();
    await i18n.setLocale("ko");
    const root = document.createElement("div");
    render(
      renderSkillHubNotifications({
        open: true,
        loading: false,
        items: [
          {
            id: "blocked",
            kind: "malware-blocked",
            message: "Original server notification",
            createdAt: 0,
            readAt: null,
          },
          {
            id: "future",
            kind: "future-notification",
            message: "Preserve the original custom message",
            createdAt: 0,
            readAt: null,
          },
        ],
        onClose: vi.fn(),
        onMarkAllRead: vi.fn(),
      }),
      root,
    );
    expect(root.textContent).toContain("악성 코드가 확인되어 차단했습니다");
    expect(root.textContent).toContain("Preserve the original custom message");
    expect(root.querySelectorAll(".skill-hub-notification.is-unread")).toHaveLength(2);
  });
  it("explains reversible deletion and prevents dismissal during a mutation", () => {
    const root = document.createElement("div");
    const close = vi.fn();
    render(
      renderSkillHubDelete({
        open: true,
        skill: "Demo",
        busy: true,
        error: null,
        onClose: close,
        onConfirm: vi.fn(),
      }),
      root,
    );
    expect(root.textContent).toContain("30 days");
    expect(root.textContent).not.toContain("cannot be undone");
    const cancel = new Event("modal-cancel", { cancelable: true });
    root.querySelector("openclaw-modal-dialog")!.dispatchEvent(cancel);
    expect(cancel.defaultPrevented).toBe(true);
    expect(close).not.toHaveBeenCalled();
  });
  it("names the destination when replacing a downloaded version", () => {
    const root = document.createElement("div");
    render(
      renderSkillHubVersionChange({
        open: true,
        currentVersion: "1.0.0",
        requestedVersion: "2.0.0",
        direction: "upgrade",
        targetLabel: "My development VM",
        busy: false,
        onClose: vi.fn(),
        onConfirm: vi.fn(),
      }),
      root,
    );
    expect(root.textContent).toContain("My development VM");
    expect(root.textContent).toContain("v1.0.0 to v2.0.0");
  });
});
