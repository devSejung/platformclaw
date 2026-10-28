/* @vitest-environment jsdom */
import { html, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { t } from "../../i18n/index.ts";
import { SkillHubLibraryController } from "./library-controller.ts";
import { skillHubJson } from "./skill-hub.test-fixtures.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("Skill Hub history identity", () => {
  it("never presents one skill's audit trail when another skill's history fails", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        skillHubJson({
          items: [
            {
              id: "event-one",
              action: "metadata-updated",
              actor: { id: "actor-one", accountId: "first.admin" },
              createdAt: 1000,
              details: { reason: "Reason belonging only to the first skill" },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(skillHubJson({ error: "Second skill history unavailable" }, 503))
      .mockResolvedValueOnce(skillHubJson({ items: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const container = document.createElement("div");
    document.body.append(container);
    const controller = new SkillHubLibraryController(
      {
        addController: vi.fn(),
        removeController: vi.fn(),
        updateComplete: Promise.resolve(true),
        requestUpdate: () => render(html`${controller.render()}`, container),
      },
      vi.fn(async () => undefined),
    );
    await controller.open({ kind: "history", id: "first-skill" });
    expect(container.textContent).toContain("first.admin");
    expect(container.textContent).toContain("Reason belonging only to the first skill");
    await controller.open({ kind: "history", id: "second-skill" });
    const alertText = container.querySelector('[role="alert"]')?.textContent;
    expect(alertText).toContain(t("skillHubPage.errors.unavailable"));
    expect(alertText).toContain("Second skill history unavailable");
    expect(container.textContent).not.toContain("first.admin");
    expect(container.textContent).not.toContain("Reason belonging only to the first skill");
    expect(container.querySelector(".skill-hub-history")).toBeNull();
    await controller.open({ kind: "history", id: "second-skill" });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).not.toContain("first.admin");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
