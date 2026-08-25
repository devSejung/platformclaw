/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { loadPlatformClawLocale } from "../../platformclaw/i18n.ts";
import { renderSkillHubUpload, renderSkillHubWorkspacePublish } from "./dialogs.ts";

function workspacePublishProps(
  overrides: Partial<Parameters<typeof renderSkillHubWorkspacePublish>[0]> = {},
): Parameters<typeof renderSkillHubWorkspacePublish>[0] {
  return {
    open: true,
    config: {
      namespaces: ["engineering"],
      maxPackageBytes: 1024,
      activeTarget: "platform_server",
      installTargets: [
        { target: "platform_server", available: true, status: "ready" },
        { target: "assigned_vm", available: true, status: "ready" },
      ],
    },
    source: "platform_server",
    skills: [{ skillKey: "release-notes", version: "1.2.0" }],
    skill: "release-notes",
    namespace: "engineering",
    version: "1.2.0",
    visibility: "NAMESPACE_ONLY",
    loading: false,
    busy: false,
    error: null,
    onClose: vi.fn(),
    onSource: vi.fn(),
    onSkill: vi.fn(),
    onNamespace: vi.fn(),
    onVersion: vi.fn(),
    onVisibility: vi.fn(),
    onPublish: vi.fn(),
    ...overrides,
  };
}

describe("Skill Hub ZIP upload dialog", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
    await loadPlatformClawLocale();
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

describe("Skill Hub workspace publish dialog", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
    await loadPlatformClawLocale();
  });

  afterEach(async () => {
    await i18n.setLocale("en");
    await loadPlatformClawLocale();
  });

  it("selects the Basic or VM workspace without changing the execution target", () => {
    const container = document.createElement("div");
    const onSource = vi.fn();
    const onPublish = vi.fn();
    render(
      renderSkillHubWorkspacePublish(workspacePublishProps({ onSource, onPublish })),
      container,
    );

    expect(container.textContent).toContain("current work location will not change");
    expect(container.textContent).toContain("Basic workspace");
    expect(container.textContent).toContain("My VM workspace");
    expect(container.querySelectorAll<HTMLSelectElement>("select")[1]?.value).toBe("release-notes");
    const source = container.querySelector<HTMLSelectElement>("select")!;
    source.value = "assigned_vm";
    source.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onSource).toHaveBeenCalledWith("assigned_vm");

    const publish = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("Scan and publish skill"),
    );
    expect(publish?.disabled).toBe(false);
    publish?.click();
    expect(onPublish).toHaveBeenCalledOnce();
  });

  it("disables unavailable VM sources and prevents publishing an empty workspace", () => {
    const container = document.createElement("div");
    render(
      renderSkillHubWorkspacePublish(
        workspacePublishProps({
          config: {
            namespaces: ["engineering"],
            maxPackageBytes: 1024,
            installTargets: [
              { target: "platform_server", available: true, status: "ready" },
              { target: "assigned_vm", available: false, status: "unassigned" },
            ],
          },
          skills: [],
          skill: "",
        }),
      ),
      container,
    );

    expect(
      container.querySelector<HTMLOptionElement>('option[value="assigned_vm"]')?.disabled,
    ).toBe(true);
    expect(container.textContent).toContain("No publishable skills were found");
    const publish = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("Scan and publish skill"),
    );
    expect(publish?.disabled).toBe(true);
  });

  it("renders workspace publishing in Korean using the PlatformClaw locale overlay", async () => {
    await i18n.setLocale("ko");
    await loadPlatformClawLocale();
    const container = document.createElement("div");

    render(renderSkillHubWorkspacePublish(workspacePublishProps()), container);

    expect(container.textContent).toContain("작업 공간의 스킬 게시");
    expect(container.textContent).toContain("내 VM 작업 공간");
    expect(container.textContent).toContain("검사 후 스킬 게시");
    expect(container.querySelectorAll<HTMLSelectElement>("select")[1]?.value).toBe("release-notes");
  });
});
