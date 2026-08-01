// PlatformClaw tests cover the personal-agent boundary on the upstream Agents view.
import { render } from "lit";
import { describe, expect, it } from "vitest";
import { t } from "../../i18n/index.ts";
import { createAgentViewTestProps as createProps } from "./agents-view.test-helpers.ts";
import { renderAgents } from "./view.ts";

function directText(element: Element): string {
  return Array.from(element.childNodes)
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent ?? "")
    .join("")
    .trim();
}

function createSkill() {
  return {
    name: "Repo Skill",
    description: "Skill description",
    source: "workspace",
    filePath: "/tmp/skill",
    baseDir: "/tmp",
    skillKey: "repo-skill",
    always: false,
    disabled: false,
    blockedByAllowlist: false,
    eligible: true,
    requirements: { anyBins: [], bins: [], env: [], config: [], os: [] },
    missing: { anyBins: [], bins: [], env: [], config: [], os: [] },
    configChecks: [],
    install: [],
  };
}

describe("renderAgents personal access", () => {
  it("limits access to editable files and read-only skills", () => {
    const container = document.createElement("div");
    render(
      renderAgents(
        createProps({
          activePanel: "skills",
          personalAccess: true,
          agentSkills: {
            report: {
              workspaceDir: "personal workspace",
              managedSkillsDir: "managed skills",
              agentId: "beta",
              skills: [createSkill() as never],
            },
            loading: false,
            error: null,
            agentId: "beta",
            filter: "",
          },
        }),
      ),
      container,
    );

    const tabs = [...container.querySelectorAll(".agents-hub-tabs .hub-tab")].map(directText);
    expect(tabs).toEqual([t("agents.tabs.files"), t("agents.tabs.skills")]);
    const buttons = [...container.querySelectorAll("button")].map((button) =>
      button.textContent?.trim(),
    );
    expect(buttons).not.toContain(t("agents.setDefault"));
    expect(buttons).not.toContain(t("common.save"));
    expect(buttons).not.toContain(t("common.reloadConfig"));
    expect(container.textContent).not.toContain(t("agents.defaults.title"));
    expect(
      (
        container.querySelector("openclaw-agent-select") as HTMLElement & {
          onCreateAgent: (() => void) | null;
        }
      ).onCreateAgent,
    ).toBeNull();
    expect(container.textContent).toContain("Repo Skill");
  });

  it("normalizes a hidden panel to files", () => {
    const container = document.createElement("div");
    render(renderAgents(createProps({ activePanel: "overview", personalAccess: true })), container);

    expect(container.querySelector("#agent-panel")?.getAttribute("aria-labelledby")).toBe(
      "agents-tab-files",
    );
  });
});
