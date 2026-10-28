/* @vitest-environment jsdom */
import { html, render } from "lit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n, t } from "../../i18n/index.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { skillHubConfig, skillHubJson, skillHubRequestUrl } from "./skill-hub.test-fixtures.ts";
import { SkillHubUploadController } from "./upload-controller.ts";

beforeEach(async () => {
  await i18n.setLocale("en");
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function setup(status: number, code?: string) {
  const requests: Array<{ url: string; file: RequestInit["body"] }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: skillHubRequestUrl(input), file: init?.body });
      if (requests.length === 1) {
        if (status === 0) {
          throw new TypeError("Connection lost after upload");
        }
        return skillHubJson(
          { error: "Upload diagnostic", ...(code ? { details: { code } } : {}) },
          status,
        );
      }
      return skillHubJson({ id: "entry", slug: "demo", version: "1.0.0" });
    }),
  );
  const config = skillHubConfig();
  const root = document.createElement("div");
  document.body.append(root);
  const controller = new SkillHubUploadController(
    {
      addController: vi.fn(),
      removeController: vi.fn(),
      updateComplete: Promise.resolve(true),
      requestUpdate: () => render(html`${controller.renderDialog(config)}`, root),
    },
    { refresh: vi.fn(async () => undefined), setMessage: vi.fn() },
  );
  const select = (file: File) => {
    const input = root.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const fill = (name: string, value: string) => {
    const input = root.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  controller.openDialog(config);
  const original = new File(["original"], "demo.zip", { type: "application/zip", lastModified: 1 });
  const replacement = new File(["replacement"], "demo.zip", {
    type: "application/zip",
    lastModified: 1,
  });
  select(original);
  fill("slug", "demo");
  const publish = () => root.querySelector<HTMLButtonElement>("button.primary")!.click();
  return { root, controller, requests, select, fill, original, replacement, publish };
}

it.each([0, 503, 409])(
  "requires the original upload after an unconfirmed %i response, without adopting a replacement File",
  async (status) => {
    const state = setup(status, status === 409 ? "skill-hub-publication-pending" : undefined);
    state.publish();
    await waitForFast(() =>
      expect(state.root.querySelector<HTMLButtonElement>("button.primary")!.disabled).toBe(false),
    );
    state.select(state.replacement);
    state.publish();
    expect(state.requests).toHaveLength(1);
    expect(state.root.querySelector('[role="alert"]')?.textContent).toContain(
      t("skillHubPage.uploadRequestUnconfirmed"),
    );
    expect(state.root.querySelector<HTMLInputElement>('input[type="file"]')!.files![0]).toBe(
      state.replacement,
    );
    state.root.querySelector<HTMLButtonElement>(".skill-hub-publication-recovery button")!.click();
    state.publish();
    await waitForFast(() => expect(state.requests).toHaveLength(2));
    expect(state.requests[1]).toEqual(state.requests[0]);
    expect(state.requests[1]!.file).toBe(state.original);
  },
);

it.each([400, 413, 415])(
  "allows a corrected ZIP after a definite preflight %i rejection with the same fields",
  async (status) => {
    const state = setup(status, status === 400 ? "skill-hub-invalid-archive" : undefined);
    state.publish();
    await waitForFast(() =>
      expect(state.root.querySelector<HTMLButtonElement>("button.primary")!.disabled).toBe(false),
    );
    state.select(state.replacement);
    state.publish();
    await waitForFast(() => expect(state.requests).toHaveLength(2));
    expect(state.requests[1]!.file).toBe(state.replacement);
    expect(
      new URL(state.requests[1]!.url, "http://localhost").searchParams.get("operationId"),
    ).not.toBe(new URL(state.requests[0]!.url, "http://localhost").searchParams.get("operationId"));
  },
);

it("releases the replacement guard only after confirmed cancellation", async () => {
  const state = setup(503);
  state.publish();
  await waitForFast(() =>
    expect(state.root.querySelector<HTMLButtonElement>("button.primary")!.disabled).toBe(false),
  );
  state.select(state.replacement);
  state.publish();
  expect(state.requests).toHaveLength(1);
  state.controller.forgetPublication(
    new URL(state.requests[0]!.url, "http://localhost").searchParams.get("operationId")!,
  );
  state.publish();
  await waitForFast(() => expect(state.requests).toHaveLength(2));
  expect(state.requests[1]!.file).toBe(state.replacement);
});

it("starts a fresh operation after the server confirms cancellation in another tab", async () => {
  const state = setup(409, "skill-hub-publication-cancelled");
  state.publish();
  await waitForFast(() =>
    expect(state.root.querySelector<HTMLButtonElement>("button.primary")!.disabled).toBe(false),
  );
  state.publish();
  await waitForFast(() => expect(state.requests).toHaveLength(2));
  expect(
    new URL(state.requests[1]!.url, "http://localhost").searchParams.get("operationId"),
  ).not.toBe(new URL(state.requests[0]!.url, "http://localhost").searchParams.get("operationId"));
});
