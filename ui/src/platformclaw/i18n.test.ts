import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "../i18n/index.ts";
import { loadAllPlatformClawLocales, platformClawProductT, platformClawT } from "./i18n.ts";
import {
  PLATFORMCLAW_WEB_DESCRIPTOR,
  PLATFORMCLAW_WEB_DESCRIPTOR_META_NAME,
} from "./web-contract.ts";

function installDescriptor(): void {
  const descriptor = document.createElement("meta");
  descriptor.name = PLATFORMCLAW_WEB_DESCRIPTOR_META_NAME;
  descriptor.content = JSON.stringify(PLATFORMCLAW_WEB_DESCRIPTOR);
  document.head.append(descriptor);
}

describe("PlatformClaw product translations", () => {
  afterEach(() => {
    document.head.querySelector(`meta[name="${PLATFORMCLAW_WEB_DESCRIPTOR_META_NAME}"]`)?.remove();
    return i18n.setLocale("en");
  });

  it("uses the PlatformClaw Korean override and the English source on locale changes", async () => {
    await loadAllPlatformClawLocales();
    await i18n.setLocale("ko");
    expect(platformClawT("configView.appearance.terminalTextSize")).toBe("터미널 텍스트 크기");

    await i18n.setLocale("en");
    expect(platformClawT("configView.appearance.terminalTextSize")).toBe("Terminal text size");
  });

  it("brands the trusted template without rewriting interpolated runtime data", () => {
    installDescriptor();

    expect(
      platformClawProductT("custodian.sessionRestarted", {
        error: "OpenClaw CLI failed.",
      }),
    ).toBe(
      "OpenClaw CLI failed. PlatformClaw started a fresh session; earlier messages remain for context.",
    );
  });
});
