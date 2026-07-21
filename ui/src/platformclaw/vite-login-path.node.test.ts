import { describe, expect, it } from "vitest";
import { rewritePlatformClawDevLoginUrl } from "../../vite.config.ts";

describe("rewritePlatformClawDevLoginUrl", () => {
  it("maps the public login contract to the Vite HTML entry", () => {
    expect(
      rewritePlatformClawDevLoginUrl("/platformclaw/login?returnTo=%2Fplatformclaw%2Fapp"),
    ).toBe("/platformclaw-login.html?returnTo=%2Fplatformclaw%2Fapp");
  });

  it("does not rewrite sibling application or API routes", () => {
    expect(rewritePlatformClawDevLoginUrl("/platformclaw/app/chat")).toBe("/platformclaw/app/chat");
    expect(rewritePlatformClawDevLoginUrl("/platformclaw/api/auth/session")).toBe(
      "/platformclaw/api/auth/session",
    );
  });
});
