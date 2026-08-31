import { render as renderLit } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import "../components/openclaw-mascot.ts";
import { controlUiPublicAssetPath } from "../app/public-assets.ts";
import { renderCustodianTranscriptEntry } from "../pages/custodian/transcript.ts";
import {
  applyPlatformClawDocumentBranding,
  resolveControlUiProductName,
  resolvePlatformClawBranding,
  resolveProductDisplayText,
  resolveSystemAgentProductDisplayText,
} from "./branding.ts";
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
    expect(resolveControlUiProductName()).toBe("OpenClaw");
    expect(resolveProductDisplayText("Ask OpenClaw")).toBe("Ask OpenClaw");
    expect(resolveSystemAgentProductDisplayText("OpenClaw retracts into shell. Bye.")).toBe(
      "OpenClaw retracts into shell. Bye.",
    );
    expect(applyPlatformClawDocumentBranding()).toBe(false);
  });

  it("uses the canonical mascot as the PlatformClaw favicon", () => {
    document.head.innerHTML = `
      <title>OpenClaw Control</title>
      <link rel="icon" type="image/svg+xml" href="/favicon.svg">
      <link rel="icon" type="image/png" href="/favicon-32.png">
      <link rel="apple-touch-icon" href="/apple-touch-icon.png">
    `;
    installDescriptor();

    expect(applyPlatformClawDocumentBranding()).toBe(true);
    expect(document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.getAttribute("href")).toBe(
      resolvePlatformClawBranding()?.mascotUrl,
    );
    expect(document.querySelector('link[rel="icon"][type="image/png"]')).toBeNull();
    expect(
      document.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]')?.getAttribute("href"),
    ).toBe(resolvePlatformClawBranding()?.mascotUrl);
    expect(document.title).toBe("PlatformClaw Control");
    expect(resolveControlUiProductName()).toBe("PlatformClaw");
    expect(resolveProductDisplayText("Ask OpenClaw")).toBe("Ask PlatformClaw");
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

  it("brands only allowlisted system-agent product copy", () => {
    installDescriptor();
    const productOwnedCopy = [
      "Setup can replace the inference route powering this session. Exit OpenClaw and run `openclaw onboard`; it saves only a route that passes a live test. Then start OpenClaw again.",
      "Channel, model, and setup flows need a human operator in the OpenClaw app; they cannot run from a delegated agent request.",
      "Heads up: the config was edited outside OpenClaw while I was away — open History to review it.",
      "Sensitive input is not accepted in the OpenClaw chat because terminal input is visible.",
      "Hi, I'm OpenClaw — caretaker of this gateway, config, channels, and agents.",
      "No active OpenClaw chat session is awaiting that wizard answer.",
      "No usable inference route is configured, so OpenClaw cannot continue.",
      "Approval pending. Human must decide in OpenClaw UI.",
      "## Hi, I'm OpenClaw — let's hatch your agent.",
      "OpenClaw setup is already in progress; try again when it finishes.",
      "OpenClaw session belongs to another caller.",
      "OpenClaw caller identity unavailable.",
      "OpenClaw online. Little claws, typed tools.",
      "OpenClaw retracts into shell. Bye.",
      "OpenClaw chat input is missing.",
      "OpenClaw approval registry unavailable",
      "OpenClaw approval apply failed",
      "Verified and configured AI access through OpenClaw setup",
      "Your agent is hatching — handing you over now. You can always find me in Settings → Ask OpenClaw.",
      "Set up OpenClaw",
      "OpenClaw change",
    ];
    for (const text of productOwnedCopy) {
      expect(resolveSystemAgentProductDisplayText(text)).toBe(
        text.replaceAll("OpenClaw", "PlatformClaw"),
      );
    }

    expect(
      resolveSystemAgentProductDisplayText("OpenClaw requires working inference: offline"),
    ).toBe("PlatformClaw requires working inference: offline");
    expect(
      resolveSystemAgentProductDisplayText("OpenClaw updated configuration: gateway.port"),
    ).toBe("PlatformClaw updated configuration: gateway.port");
    expect(
      resolveSystemAgentProductDisplayText("Configuration edited outside OpenClaw: gateway.port"),
    ).toBe("Configuration edited outside PlatformClaw: gateway.port");

    for (const technicalOrUserText of [
      "Investigate OpenClaw upstream",
      "OpenClaw config remains compatible with `openclaw onboard`.",
      "Third-party plugin: Audit OpenClaw compatibility",
      "Prefix: OpenClaw requires working inference: quoted text",
      'The docs quote "OpenClaw retracts into shell. Bye." exactly.',
    ]) {
      expect(resolveSystemAgentProductDisplayText(technicalOrUserText)).toBe(technicalOrUserText);
    }
  });

  it("brands only assistant-owned lines in the custodian renderer", () => {
    installDescriptor();
    const container = document.createElement("div");
    document.body.append(container);
    const renderMessage = (role: "assistant" | "user", text: string) => {
      renderLit(
        renderCustodianTranscriptEntry({
          message: { id: 1, role, text, at: 0, question: null, step: null },
          boundaryAfterId: null,
          assistantAvatar: "",
          showQuestion: false,
          questionDisabled: false,
          showWizardStep: false,
          wizardValue: undefined,
          wizardDisabled: false,
          wizardSecretVisible: false,
          onSelect: () => undefined,
          onSkip: () => undefined,
          onWizardValueChange: () => undefined,
          onWizardAnswer: () => undefined,
          onToggleWizardSecretVisibility: () => undefined,
        }),
        container,
      );
      return container.textContent;
    };

    expect(renderMessage("assistant", "OpenClaw retracts into shell. Bye.")).toContain(
      "PlatformClaw retracts into shell. Bye.",
    );
    expect(renderMessage("user", "OpenClaw retracts into shell. Bye.")).toContain(
      "OpenClaw retracts into shell. Bye.",
    );
    expect(renderMessage("assistant", "Investigate OpenClaw upstream")).toContain(
      "Investigate OpenClaw upstream",
    );
  });
});
