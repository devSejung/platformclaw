import { describe, expect, it } from "vitest";
import { PLATFORMCLAW_DEFAULT_APP_PATH, resolvePlatformClawReturnTo } from "./web-contract.ts";

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
