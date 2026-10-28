/* @vitest-environment jsdom */
import { html, render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  skillHubConfig,
  skillHubJson,
  skillHubRequestBody,
  skillHubRequestUrl,
} from "./skill-hub.test-fixtures.ts";
import { SkillHubWorkspacePublishController } from "./workspace-publish-controller.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it("keeps a reopened publishing draft when an earlier opening finishes last", async () => {
  await i18n.setLocale("en");
  let resolveFirst!: (response: Response) => void;
  const firstRead = new Promise<Response>((resolve) => {
    resolveFirst = resolve;
  });
  const requests: Array<Record<string, unknown>> = [];
  let reads = 0;
  const items = [
    { skillKey: "alpha", version: "1.0.0" },
    { skillKey: "beta", version: "2.0.0" },
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = skillHubRequestUrl(input);
      if (url.includes("/workspace-skills")) {
        reads += 1;
        if (reads === 1) {
          return firstRead;
        }
        return skillHubJson({
          source: "assigned_vm",
          targetId: "vm-beta",
          targetRevision: 2,
          targetLabel: "Beta VM",
          items,
        });
      }
      const body = JSON.parse(skillHubRequestBody(init?.body)) as Record<string, unknown>;
      requests.push(body);
      return skillHubJson({ id: "entry-beta", slug: body.skill, version: body.version });
    }),
  );
  const config = skillHubConfig({
    scopes: [{ id: "another-part", kind: "part", name: "Another Part" }],
  });
  const container = document.createElement("div");
  document.body.append(container);
  const controller = new SkillHubWorkspacePublishController(
    {
      addController: vi.fn(),
      removeController: vi.fn(),
      updateComplete: Promise.resolve(true),
      requestUpdate: () => render(html`${controller.renderDialog(config)}`, container),
    },
    { refresh: vi.fn(async () => undefined), setMessage: vi.fn() },
  );
  const firstOpening = controller.openDialog(config, undefined, {
    source: "platform_server",
    skill: "alpha",
  });
  await waitForFast(() => expect(reads).toBe(1));
  const close = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === "Close",
  )!;
  close.click();
  await controller.openDialog(config, undefined, { source: "assigned_vm", skill: "beta" });
  const version = container.querySelector<HTMLInputElement>('[name="version"]')!;
  version.value = "7.0.0";
  version.dispatchEvent(new Event("input", { bubbles: true }));
  const sharing = container.querySelector<HTMLSelectElement>('[name="sharing"]')!;
  sharing.value = "SELECTED";
  sharing.dispatchEvent(new Event("change", { bubbles: true }));
  container.querySelector<HTMLInputElement>('[value="another-part"]')!.click();
  resolveFirst(
    skillHubJson({
      source: "platform_server",
      targetId: "platform-server",
      targetRevision: 1,
      items,
    }),
  );
  await firstOpening;
  expect(container.querySelector<HTMLSelectElement>('[name="skill"]')!.value).toBe("beta");
  expect(container.querySelector<HTMLSelectElement>('[name="source"]')!.value).toBe("assigned_vm");
  expect(container.querySelector<HTMLInputElement>('[name="version"]')!.value).toBe("7.0.0");
  expect(container.querySelector<HTMLSelectElement>('[name="sharing"]')!.value).toBe("SELECTED");
  expect(container.querySelector<HTMLInputElement>('[value="another-part"]')!.checked).toBe(true);
  container.querySelector<HTMLButtonElement>("button.primary")!.click();
  await waitForFast(() => expect(requests).toHaveLength(1));
  expect(requests[0]).toMatchObject({
    skill: "beta",
    source: "assigned_vm",
    expectedTargetId: "vm-beta",
    version: "7.0.0",
    sharing: { mode: "SELECTED", scopeIds: ["another-part"], userIds: [] },
  });
});
