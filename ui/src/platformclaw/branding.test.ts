import { afterEach, describe, expect, it } from "vitest";
import "../components/openclaw-mascot.ts";
import { controlUiPublicAssetPath } from "../app/public-assets.ts";
import { applyPlatformClawDocumentBranding, resolvePlatformClawBranding } from "./branding.ts";
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

describe("PlatformClaw branding", () => {
  afterEach(() => {
    document.head.replaceChildren();
    document.body.replaceChildren();
    delete document.documentElement.dataset.platformclawHosted;
  });

  it("stays inactive on the upstream Control UI", () => {
    expect(resolvePlatformClawBranding()).toBeNull();
    expect(applyPlatformClawDocumentBranding()).toBe(false);
  });

  it("uses the canonical mascot as the PlatformClaw favicon", () => {
    document.head.innerHTML = `
      <link rel="icon" type="image/svg+xml" href="/favicon.svg">
      <link rel="icon" type="image/png" href="/favicon-32.png">
    `;
    installDescriptor();

    expect(applyPlatformClawDocumentBranding()).toBe(true);
    expect(document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.getAttribute("href")).toBe(
      resolvePlatformClawBranding()?.mascotUrl,
    );
    expect(document.querySelector('link[rel="icon"][type="image/png"]')).toBeNull();
    expect(document.documentElement.dataset.platformclawHosted).toBe("");
  });

  it("rebrands shared mascot surfaces without replacing upstream call sites", async () => {
    installDescriptor();
    const mascot = document.createElement("openclaw-mascot") as HTMLElement & {
      updateComplete: Promise<boolean>;
    };
    document.body.append(mascot);
    await mascot.updateComplete;

    const image = mascot.shadowRoot?.querySelector<HTMLImageElement>(".platformclaw-mascot");
    expect(image?.getAttribute("src")).toBe(resolvePlatformClawBranding()?.mascotUrl);
    expect(mascot.shadowRoot?.querySelector("canvas")).toBeNull();
  });

  it("rebrands shared fallback logos used by chat and shell surfaces", () => {
    installDescriptor();

    expect(controlUiPublicAssetPath("apple-touch-icon.png", "/platformclaw/app")).toBe(
      resolvePlatformClawBranding()?.mascotUrl,
    );
    expect(controlUiPublicAssetPath("manifest.webmanifest", "/platformclaw/app")).toBe(
      "/platformclaw/app/manifest.webmanifest",
    );
  });
});
