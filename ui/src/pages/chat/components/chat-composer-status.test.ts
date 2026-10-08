import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../../i18n/index.ts";
import { captureI18nStateForTesting } from "../../../i18n/lib/translate.test-support.ts";
import { buildCompactionDividerItem } from "../chat-progress.ts";
import { renderFallbackIndicator } from "./chat-composer-status.ts";
import { renderChatDivider } from "./chat-divider.ts";

describe("chat composer status localization", () => {
  let restoreI18nState: () => Promise<void>;

  beforeEach(async () => {
    restoreI18nState = captureI18nStateForTesting();
    await i18n.setLocale("de");
    vi.spyOn(Date, "now").mockReturnValue(1_000);
  });

  afterEach(async () => {
    await restoreI18nState();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("renders translated compaction and fallback status", () => {
    render(renderChatDivider(buildCompactionDividerItem({}, 1_000, 0, "active")), document.body);
    expect(document.querySelector(".chat-divider__title")?.textContent?.trim()).toBe(
      "Kontext wird komprimiert...",
    );

    render(
      renderFallbackIndicator({
        selected: "provider/selected",
        active: "provider/active",
        attempts: ["provider/selected: rate limit"],
        occurredAt: 900,
      }),
      document.body,
    );
    const fallback = document.querySelector(".compaction-indicator--fallback");
    expect(fallback?.textContent?.trim()).toBe("Fallback aktiv: provider/active");
    expect(fallback?.getAttribute("aria-label")).toBe(
      "Ausgewählt: provider/selected • Aktiv: provider/active • Versuche: provider/selected: rate limit",
    );
  });
});
