import { beforeEach, describe, expect, it } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { pluginsHubTabs } from "./plugins-hub.ts";

describe("pluginsHubTabs", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  it("limits tabs to the PlatformClaw personal surface", () => {
    expect(pluginsHubTabs(null, ["skills", "workshop"]).map((tab) => tab.value)).toEqual([
      "skills",
      "workshop",
    ]);
  });
});
