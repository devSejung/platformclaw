import { afterEach, describe, expect, it } from "vitest";
import { platformClawProductT } from "./i18n.ts";
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
