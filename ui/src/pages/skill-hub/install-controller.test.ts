/* @vitest-environment jsdom */

import { html, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { SkillHubInstallController } from "./install-controller.ts";

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function installationFixture(installedVersion?: string) {
  let finish!: (value: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/install")) {
      return pending;
    }
    const source = new URL(url, "http://localhost").searchParams.get("source");
    return response({
      source,
      items: installedVersion ? [{ skillKey: "notes", version: installedVersion }] : [],
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  const container = document.createElement("div");
  document.body.append(container);
  let version = "2.0.0";
  const message = vi.fn();
  const controller = new SkillHubInstallController(
    {
      addController: vi.fn(),
      removeController: vi.fn(),
      requestUpdate: () => update(),
      updateComplete: Promise.resolve(true),
    },
    message,
  );
  function update() {
    render(html`${controller.render(version)}${controller.renderConfirmation()}`, container);
  }
  const open = (slug = "notes") =>
    controller.open(
      { namespace: "engineering", slug },
      {
        namespaces: ["engineering"],
        defaultNamespace: "engineering",
        namespaceOptions: [{ namespace: "engineering", scopeKind: "global" }],
        maxPackageBytes: 1024,
        installTargets: [
          { target: "platform_server", available: true, status: "ready" },
          { target: "assigned_vm", available: true, status: "ready" },
        ],
      },
    );
  open();
  const basic = () => container.querySelector('[data-install-target="platform_server"]')!;
  const vm = () => container.querySelector('[data-install-target="assigned_vm"]')!;
  const button = () => basic().querySelector("button")!;
  await waitForFast(() =>
    expect(basic().querySelector('[role="status"]')?.textContent).toContain(
      installedVersion ? `v${installedVersion}` : "Not downloaded",
    ),
  );
  return {
    container,
    controller,
    basic,
    vm,
    button,
    finish,
    message,
    open,
    changeVersion: (value: string) => {
      version = value;
      update();
    },
  };
}

function clickPointer(button: HTMLButtonElement) {
  button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
}

const completion = ".skill-hub-destination__completion";
const success = { ok: true, slug: "notes", version: "2.0.0", target: "platform_server" };

describe("Skill Hub install completion feedback", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it("reveals only the successful destination and preserves its live status and unrelated content", async () => {
    const fixture = await installationFixture();
    const status = fixture.basic().querySelector('[role="status"]');
    const vmContent = fixture.vm().querySelector('[role="status"] span');
    clickPointer(fixture.button());
    expect(fixture.container.querySelector(completion)).toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    fixture.finish(response(success));
    await waitForFast(() => expect(fixture.basic().querySelector(completion)).not.toBeNull());
    expect(fixture.basic().querySelector('[role="status"]')).toBe(status);
    expect(status?.textContent).toContain("v2.0.0");
    expect(fixture.vm().querySelector('[role="status"] span')).toBe(vmContent);
    expect(fixture.vm().querySelector(completion)).toBeNull();
    const completedContent = fixture.basic().querySelector(completion);
    fixture.changeVersion("1.0.0");
    expect(fixture.basic().querySelector(completion)).toBe(completedContent);
    expect(fixture.button().disabled).toBe(false);
  });

  it("keeps keyboard and programmatic installs instant even if the user clicks while awaiting completion", async () => {
    const fixture = await installationFixture();
    fixture.button().click();
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    fixture.finish(response(success));
    await waitForFast(() => expect(fixture.controller.busy).toBe(false));
    expect(fixture.button().disabled).toBe(true);
    expect(fixture.basic().querySelector('[role="status"]')?.textContent).toContain("v2.0.0");
    expect(fixture.container.querySelector(completion)).toBeNull();
  });

  it("does not celebrate inventory loads, already installed versions or failed installs", async () => {
    const fixture = await installationFixture("2.0.0");
    expect(fixture.container.querySelector(completion)).toBeNull();
    fixture.changeVersion("1.0.0");
    clickPointer(fixture.button());
    fixture.finish(response({ error: "Installation unavailable. Retry." }, 503));
    await waitForFast(() => expect(fixture.controller.busy).toBe(false));
    expect(fixture.message).toHaveBeenCalledWith({
      kind: "error",
      text: "Installation unavailable. Retry.",
    });
    expect(fixture.container.querySelector(completion)).toBeNull();
  });

  it("discards a successful response after the detail closes or changes", async () => {
    const fixture = await installationFixture();
    clickPointer(fixture.button());
    fixture.controller.clear();
    fixture.open("another-skill");
    fixture.finish(response(success));
    await waitForFast(() => expect(fixture.controller.busy).toBe(false));
    expect(fixture.basic().querySelector('[role="status"]')?.textContent).toContain(
      "Not downloaded",
    );
    expect(fixture.container.querySelector(completion)).toBeNull();
    expect(fixture.message).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "success" }));
  });
});
