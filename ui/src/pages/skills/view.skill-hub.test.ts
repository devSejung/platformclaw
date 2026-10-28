/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { skillHubConfig } from "../skill-hub/skill-hub.test-fixtures.ts";
import { createProps, createSkill, normalizeText } from "./view.test-helpers.ts";
import { renderSkills } from "./view.ts";

describe("Skills workspace Skill Hub entry point", () => {
  it.each(["openclaw-workspace", "platformclaw-vm-workspace"])(
    "offers publishing for %s through the shared publication flow",
    (source) => {
      const container = document.createElement("div");
      const onSkillHubPublishOpen = vi.fn();
      const props = createProps({
        personalAccess: true,
        canUpdate: false,
        canInstall: false,
        skillHubConfig: skillHubConfig(),
        onSkillHubPublishOpen,
      });
      props.report = {
        ...expectDefined(props.report, "skills report"),
        skills: [createSkill({ source, skillKey: "my-skill" })],
      };
      render(renderSkills(props), container);
      const publish = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
        button.textContent?.includes("Publish to Hub"),
      )!;
      expect(publish.disabled).toBe(false);
      publish.click();
      expect(onSkillHubPublishOpen).toHaveBeenCalledWith("my-skill");
      expect(normalizeText(container)).not.toContain("Namespace");
    },
  );
  it("keeps a visible outcome after the publication dialog closes", () => {
    const container = document.createElement("div");
    render(
      renderSkills(
        createProps({
          skillHubMessage: {
            kind: "warning",
            text: "Publication saved; ownership review required.",
          },
        }),
      ),
      container,
    );
    expect(container.querySelector(".callout.warning")?.textContent).toContain(
      "ownership review required",
    );
  });
});
