import mascotUrl from "./platformclaw-pixel.svg?url";
import { PLATFORMCLAW_WEB_DESCRIPTOR_META_NAME } from "./web-contract.ts";

type PlatformClawBranding = {
  mascotUrl: string;
  productName: "PlatformClaw";
};

const UPSTREAM_PRODUCT_NAME = "OpenClaw";

const PLATFORMCLAW_BRANDING: PlatformClawBranding = {
  mascotUrl,
  productName: "PlatformClaw",
};

// System-agent payloads can also contain model, user, and technical OpenClaw
// text. Only these product-owned fixed fragments may change; longest comes first.
const SYSTEM_AGENT_PRODUCT_COPY = [
  [
    "Setup can replace the inference route powering this session. Exit OpenClaw and run `openclaw onboard`; it saves only a route that passes a live test. Then start OpenClaw again.",
    "Setup can replace the inference route powering this session. Exit PlatformClaw and run `openclaw onboard`; it saves only a route that passes a live test. Then start PlatformClaw again.",
  ],
  [
    "Channel, model, and setup flows need a human operator in the OpenClaw app; they cannot run from a delegated agent request.",
    "Channel, model, and setup flows need a human operator in the PlatformClaw app; they cannot run from a delegated agent request.",
  ],
  [
    "Heads up: the config was edited outside OpenClaw while I was away — open History to review it.",
    "Heads up: the config was edited outside PlatformClaw while I was away — open History to review it.",
  ],
  [
    "Sensitive input is not accepted in the OpenClaw chat because terminal input is visible.",
    "Sensitive input is not accepted in the PlatformClaw chat because terminal input is visible.",
  ],
  [
    "Hi, I'm OpenClaw — caretaker of this gateway, config, channels, and agents.",
    "Hi, I'm PlatformClaw — caretaker of this gateway, config, channels, and agents.",
  ],
  [
    "No active OpenClaw chat session is awaiting that wizard answer.",
    "No active PlatformClaw chat session is awaiting that wizard answer.",
  ],
  [
    "No usable inference route is configured, so OpenClaw cannot continue.",
    "No usable inference route is configured, so PlatformClaw cannot continue.",
  ],
  [
    "Approval pending. Human must decide in OpenClaw UI.",
    "Approval pending. Human must decide in PlatformClaw UI.",
  ],
  [
    "## Hi, I'm OpenClaw — let's hatch your agent.",
    "## Hi, I'm PlatformClaw — let's hatch your agent.",
  ],
  [
    "OpenClaw setup is already in progress; try again when it finishes.",
    "PlatformClaw setup is already in progress; try again when it finishes.",
  ],
  [
    "OpenClaw session belongs to another caller.",
    "PlatformClaw session belongs to another caller.",
  ],
  ["OpenClaw caller identity unavailable.", "PlatformClaw caller identity unavailable."],
  [
    "OpenClaw online. Little claws, typed tools.",
    "PlatformClaw online. Little claws, typed tools.",
  ],
  ["OpenClaw retracts into shell. Bye.", "PlatformClaw retracts into shell. Bye."],
  ["OpenClaw chat input is missing.", "PlatformClaw chat input is missing."],
  ["OpenClaw approval registry unavailable", "PlatformClaw approval registry unavailable"],
  ["OpenClaw approval apply failed", "PlatformClaw approval apply failed"],
  [
    "Verified and configured AI access through OpenClaw setup",
    "Verified and configured AI access through PlatformClaw setup",
  ],
  [
    "Your agent is hatching — handing you over now. You can always find me in Settings → Ask OpenClaw.",
    "Your agent is hatching — handing you over now. You can always find me in Settings → Ask PlatformClaw.",
  ],
  ["Set up OpenClaw", "Set up PlatformClaw"],
  ["OpenClaw change", "PlatformClaw change"],
] as const;

const SYSTEM_AGENT_PRODUCT_PREFIX_COPY = [
  ["OpenClaw requires working inference: ", "PlatformClaw requires working inference: "],
  ["OpenClaw updated configuration", "PlatformClaw updated configuration"],
  ["Configuration edited outside OpenClaw", "Configuration edited outside PlatformClaw"],
] as const;

export function resolvePlatformClawBranding(root?: ParentNode): PlatformClawBranding | null {
  const target = root ?? (typeof document === "undefined" ? null : document);
  return target?.querySelector(`meta[name="${PLATFORMCLAW_WEB_DESCRIPTOR_META_NAME}"]`)
    ? PLATFORMCLAW_BRANDING
    : null;
}

export function resolveControlUiProductName(root?: ParentNode): string {
  return resolvePlatformClawBranding(root)?.productName ?? UPSTREAM_PRODUCT_NAME;
}

export function resolveProductDisplayText(value: string, root?: ParentNode): string {
  if (!value.includes(UPSTREAM_PRODUCT_NAME)) {
    return value;
  }
  const branding = resolvePlatformClawBranding(root);
  return branding ? value.replaceAll(UPSTREAM_PRODUCT_NAME, branding.productName) : value;
}

export function resolveSystemAgentProductDisplayText(value: string, root?: ParentNode): string {
  if (!resolvePlatformClawBranding(root)) {
    return value;
  }
  return value
    .split("\n")
    .map((rawLine) => {
      const carriageReturn = rawLine.endsWith("\r") ? "\r" : "";
      const line = carriageReturn ? rawLine.slice(0, -1) : rawLine;
      const exact = SYSTEM_AGENT_PRODUCT_COPY.find(([upstream]) => line === upstream);
      if (exact) {
        return `${exact[1]}${carriageReturn}`;
      }
      for (const [upstream, platformClaw] of SYSTEM_AGENT_PRODUCT_PREFIX_COPY) {
        if (line.startsWith(upstream)) {
          return `${platformClaw}${line.slice(upstream.length)}${carriageReturn}`;
        }
      }
      return rawLine;
    })
    .join("\n");
}

export function resolvePlatformClawBrandAsset(asset: string, root?: ParentNode): string | null {
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
  root.title = resolveProductDisplayText(root.title, root);
  const svgIcon = root.querySelector<HTMLLinkElement>('link[rel="icon"][type="image/svg+xml"]');
  if (svgIcon) {
    svgIcon.href = branding.mascotUrl;
  }
  const appleTouchIcon = root.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]');
  if (appleTouchIcon) {
    appleTouchIcon.href = branding.mascotUrl;
  }
  root.querySelector<HTMLLinkElement>('link[rel="icon"][type="image/png"]')?.remove();
  return true;
}
