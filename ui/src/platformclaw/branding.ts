import mascotUrl from "./platformclaw-pixel.svg?url";
import { PLATFORMCLAW_WEB_DESCRIPTOR_META_NAME } from "./web-contract.ts";

export type PlatformClawBranding = {
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

export function applyPlatformClawDocumentBranding(root: Document = document): boolean {
  const branding = resolvePlatformClawBranding(root);
  if (!branding) {
    return false;
  }

  const svgIcon = root.querySelector<HTMLLinkElement>('link[rel="icon"][type="image/svg+xml"]');
  if (svgIcon) {
    svgIcon.href = branding.mascotUrl;
  }
  root.querySelector<HTMLLinkElement>('link[rel="icon"][type="image/png"]')?.remove();
  return true;
}
