import { describe, expect, it } from "vitest";
import {
  parsePlatformClawWebDescriptor,
  PLATFORMCLAW_DEFAULT_APP_PATH,
  PLATFORMCLAW_WEB_DESCRIPTOR,
  readPlatformClawWebDescriptor,
  resolvePlatformClawReturnTo,
} from "./web-contract.ts";

function locationFor(returnTo?: string): Pick<Location, "href" | "origin"> {
  const url = new URL("https://platformclaw.example/platformclaw/login");
  if (returnTo !== undefined) {
    url.searchParams.set("returnTo", returnTo);
  }
  return { href: url.href, origin: url.origin };
}

describe("resolvePlatformClawReturnTo", () => {
  it("accepts only same-origin PlatformClaw application routes", () => {
    expect(
      resolvePlatformClawReturnTo(locationFor("/platformclaw/app/sessions?q=active#top")),
    ).toBe("/platformclaw/app/sessions?q=active#top");
    expect(
      resolvePlatformClawReturnTo(
        locationFor("https://platformclaw.example/platformclaw/app/chat"),
      ),
    ).toBe("/platformclaw/app/chat");
  });

  it.each([
    undefined,
    "https://evil.example/platformclaw/app/chat",
    "//evil.example/platformclaw/app/chat",
    "/platformclaw/api/auth/session",
    "/platformclaw/application/chat",
    "/platformclaw/app\\..\\login",
    "not a valid app route",
  ])("falls back for unsafe returnTo %s", (returnTo) => {
    expect(resolvePlatformClawReturnTo(locationFor(returnTo))).toBe(PLATFORMCLAW_DEFAULT_APP_PATH);
  });
});

describe("PlatformClaw Web descriptor", () => {
  it("accepts only the fixed browser bootstrap contract", () => {
    expect(parsePlatformClawWebDescriptor({ ...PLATFORMCLAW_WEB_DESCRIPTOR })).toBe(
      PLATFORMCLAW_WEB_DESCRIPTOR,
    );
    document.head.innerHTML = `<meta name="platformclaw-web-descriptor" content='${JSON.stringify(PLATFORMCLAW_WEB_DESCRIPTOR)}'>`;
    expect(readPlatformClawWebDescriptor(document)).toBe(PLATFORMCLAW_WEB_DESCRIPTOR);
  });

  it.each([
    { ...PLATFORMCLAW_WEB_DESCRIPTOR, agentId: "person_one" },
    { ...PLATFORMCLAW_WEB_DESCRIPTOR, gatewayPath: "wss://gateway.example" },
    { ...PLATFORMCLAW_WEB_DESCRIPTOR, enabledRoutes: ["chat", "agents"] },
    { ...PLATFORMCLAW_WEB_DESCRIPTOR, mode: "operator" },
  ])("rejects expanded or changed browser authority", (descriptor) => {
    expect(() => parsePlatformClawWebDescriptor(descriptor)).toThrow(
      /descriptor (fields|values) are invalid/,
    );
  });
});
