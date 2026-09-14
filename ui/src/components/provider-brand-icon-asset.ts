import { html } from "lit";

/**
 * Render a known provider asset without loading the provider catalog resolver.
 * Keep this small because session-row-badges.ts is part of the startup bundle.
 */
export function renderProviderBrandIconAsset(icon: string, options?: { className?: string }) {
  const surfaceClass = options?.className ? ` ${options.className}` : "";
  const assetPath = `provider-icons/ProviderIcon-${icon}.svg`;
  return html`
    <span
      class="provider-brand-icon${surfaceClass}"
      data-provider-icon=${icon}
      style=${`--provider-icon-url: url("${assetPath}")`}
      aria-hidden="true"
    ></span>
  `;
}
