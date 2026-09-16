import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { createGateway, createSessions, mountSidebar } from "../app-sidebar.ts";
import "../../components/app-sidebar.ts";

describe("AppSidebar footer save feedback", () => {
  it("renders config save feedback in the workspace footer when supplied", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));
    sidebar.saveIndicator = {
      status: "error",
      lastError: "Save failed",
      needsApply: false,
      applying: false,
      applyDisabled: false,
      onRetry: vi.fn(),
      onReload: vi.fn(),
      onApply: vi.fn(),
    };
    await sidebar.updateComplete;

    const indicator = sidebar.querySelector("openclaw-settings-save-indicator");
    await (indicator as { updateComplete?: Promise<unknown> } | null)?.updateComplete;
    const status = indicator?.querySelector('[role="status"]');
    expect(status?.getAttribute("aria-label")).toBe(
      `${t("configView.autoSaveFailed")}: Save failed`,
    );
    expect(status?.textContent).toContain("Save failed");
    expect(status?.textContent).toContain("Retry");
    const footerBar = sidebar.querySelector(".sidebar-footer-bar");
    expect(indicator).not.toBeNull();
    expect(footerBar).not.toBeNull();
    if (!indicator || !footerBar) {
      return;
    }
    expect(
      indicator.compareDocumentPosition(footerBar) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  });
});
