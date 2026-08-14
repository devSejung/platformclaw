/* @vitest-environment jsdom */

import { render } from "lit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { renderSkillHubUpload } from "./dialogs.ts";

describe("Skill Hub ZIP upload dialog", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  it("uses server limits and blocks an oversized archive", () => {
    const container = document.createElement("div");
    const onPublish = vi.fn();
    render(
      renderSkillHubUpload({
        open: true,
        config: { namespaces: ["engineering"], maxPackageBytes: 1024, maxUploadBytes: 4 },
        file: new File(["12345"], "skill.zip", { type: "application/zip" }),
        slug: "release-notes",
        namespace: "engineering",
        version: "1.0.0",
        visibility: "NAMESPACE_ONLY",
        busy: false,
        onClose: vi.fn(),
        onFile: vi.fn(),
        onSlug: vi.fn(),
        onNamespace: vi.fn(),
        onVersion: vi.fn(),
        onVisibility: vi.fn(),
        onPublish,
      }),
      container,
    );

    expect(container.textContent).toContain("larger than the 500 MB upload limit");
    const publish = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("Scan and publish ZIP"),
    );
    expect(publish?.disabled).toBe(true);
    publish?.click();
    expect(onPublish).not.toHaveBeenCalled();
  });
});
