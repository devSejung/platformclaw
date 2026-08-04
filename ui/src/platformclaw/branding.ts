import mascotUrl from "./platformclaw-pixel.svg?url";
import { PLATFORMCLAW_WEB_DESCRIPTOR_META_NAME } from "./web-contract.ts";

type PlatformClawBranding = {
  mascotUrl: string;
  productName: "PlatformClaw";
};

const PLATFORMCLAW_BRANDING: PlatformClawBranding = {
  mascotUrl,
  productName: "PlatformClaw",
};

export function resolvePlatformClawBranding(
  root: ParentNode = document,
): PlatformClawBranding | null {
  return root.querySelector(`meta[name="${PLATFORMCLAW_WEB_DESCRIPTOR_META_NAME}"]`)
    ? PLATFORMCLAW_BRANDING
    : null;
}

export function resolvePlatformClawBrandAsset(
  asset: string,
  root: ParentNode = document,
): string | null {
  const branding = resolvePlatformClawBranding(root);
  if (
    !branding ||
    !["apple-touch-icon.png", "favicon-32.png", "favicon.ico", "favicon.svg"].includes(asset)
  ) {
    return null;
  }
  return branding.mascotUrl;
}

export function applyPlatformClawDocumentBranding(root: Document = document): boolean {
  const branding = resolvePlatformClawBranding(root);
  if (!branding) {
    return false;
  }

  // The hosted browser surface is document-heavy: errors, logs, configuration,
  // and transcripts must remain selectable even though upstream app chrome
  // disables selection by default.
  root.documentElement.dataset.platformclawHosted = "";
  const svgIcon = root.querySelector<HTMLLinkElement>('link[rel="icon"][type="image/svg+xml"]');
  if (svgIcon) {
    svgIcon.href = branding.mascotUrl;
  }
  root.querySelector<HTMLLinkElement>('link[rel="icon"][type="image/png"]')?.remove();
  return true;
}
