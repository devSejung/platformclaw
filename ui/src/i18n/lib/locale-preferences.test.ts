// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { LOCALE_STORAGE_KEY, resolveInitialLocalePreference } from "./locale-preferences.ts";

afterEach(() => vi.unstubAllGlobals());

describe("initial locale preference", () => {
  it.each([
    ["en", "ko-KR", "en", true],
    ["ko", "en-US", "ko", true],
    [null, "ko-KR", "ko", false],
    ["unsupported", "en-US", "en", false],
    [null, "zh-Hant-HK", "zh-TW", false],
  ] as const)("resolves saved %s with browser %s", (saved, browser, locale, shouldPersist) => {
    const storage = createStorageMock();
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("navigator", { language: browser });
    if (saved !== null) {
      storage.setItem(LOCALE_STORAGE_KEY, saved);
    }
    expect(resolveInitialLocalePreference()).toEqual({ locale, shouldPersist });
    // Selection stays read-only; the manager owns explicit/system persistence.
    expect(storage.getItem(LOCALE_STORAGE_KEY)).toBe(saved);
  });

  it("uses the system locale when storage is blocked", () => {
    vi.stubGlobal("localStorage", {
      getItem() {
        throw new DOMException("blocked", "SecurityError");
      },
      setItem() {},
    });
    vi.stubGlobal("navigator", { language: "ko-KR" });
    expect(resolveInitialLocalePreference()).toEqual({ locale: "ko", shouldPersist: false });
  });
});
