/* @vitest-environment jsdom */

import { html, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { loadPlatformClawLocale } from "../../platformclaw/i18n.ts";
import type { PlatformClawSkillHubConfig } from "../../platformclaw/skill-hub.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { SkillHubNamespaceController } from "./namespace-controller.ts";

const config: PlatformClawSkillHubConfig = {
  namespaces: ["global"],
  defaultNamespace: "global",
  namespaceOptions: [{ namespace: "global", scopeKind: "global" }],
  maxPackageBytes: 1024,
  admin: false,
  capabilities: {
    scanner: true,
    forcePublish: false,
    ownerTransfer: false,
    accessControl: false,
    notifications: true,
    zipUpload: true,
    namespaceCreate: true,
  },
};
const scopes = [
  { scopeKind: "team", scopeId: "team-one", scopeName: "Engineering" },
  { scopeKind: "global" },
  { scopeKind: "group", scopeId: "group-one", scopeName: "Platform" },
  { scopeKind: "part", scopeId: "part-one", scopeName: "Runtime" },
];
function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
function setup(
  options: {
    status?: number;
    code?: string;
    scopeFailure?: boolean;
    refreshFailure?: boolean;
    creations?: Array<Record<string, unknown>>;
  } = {},
) {
  let status = options.status ?? 200;
  let scopeFailure = options.scopeFailure;
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method !== "POST") {
      return scopeFailure
        ? response({ error: "Scopes unavailable" }, 503)
        : response({ scopes, creations: options.creations ?? [] });
    }
    return response(
      status === 200
        ? { namespace: "release-tools" }
        : { error: "Creation rejected", details: { code: options.code } },
      status,
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  const container = document.createElement("div");
  document.body.append(container);
  const refresh = options.refreshFailure
    ? vi.fn(async () => {
        throw new Error("Config reload failed");
      })
    : vi.fn(async () => {});
  const message = vi.fn();
  const controller = new SkillHubNamespaceController(
    {
      addController: vi.fn(),
      removeController: vi.fn(),
      requestUpdate: () => update(),
      updateComplete: Promise.resolve(true),
    },
    { refresh, setMessage: message },
  );
  function update() {
    render(html`${controller.renderAction(config)}${controller.renderDialog()}`, container);
  }
  update();
  const action = () => container.querySelector<HTMLButtonElement>("button")!;
  const dialog = () => container.querySelector<HTMLFormElement>("form")!;
  const name = () => dialog().querySelector<HTMLInputElement>('input[name="namespace"]')!;
  const scope = () => dialog().querySelector<HTMLSelectElement>('select[name="scope"]')!;
  const changeName = (value: string) => {
    name().value = value;
    name().dispatchEvent(new Event("input", { bubbles: true }));
  };
  const submit = () =>
    dialog().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  const open = async () => {
    action().click();
    await waitForFast(() => expect(scope().disabled).toBe(false));
  };
  return {
    action,
    dialog,
    name,
    scope,
    changeName,
    submit,
    open,
    fetchMock,
    refresh,
    message,
    controller,
    container,
    succeed: () => {
      status = 200;
      scopeFailure = false;
    },
  };
}

describe("member namespace creation", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
    await loadPlatformClawLocale();
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
    await i18n.setLocale("en");
    await loadPlatformClawLocale();
  });

  it.each([1, 0, 2, 3])(
    "creates in authorized scope %s with Global selected independently of option order",
    async (scopeIndex) => {
      const f = setup();
      await f.open();
      expect(f.scope().value).toBe("1");
      expect(f.container.textContent).toContain("Company-wide");
      expect(f.dialog().querySelector("small")?.textContent).toContain("2–64 lowercase ASCII");
      expect(f.dialog().querySelector("small")?.textContent).toContain("consecutive hyphens");
      expect(f.container.textContent).not.toContain("Secret Part");
      f.changeName(" Release-Tools ");
      f.scope().value = String(scopeIndex);
      f.scope().dispatchEvent(new Event("change", { bubbles: true }));
      f.submit();
      await waitForFast(() => expect(f.dialog()).toBeNull());
      expect(f.fetchMock).toHaveBeenLastCalledWith(
        expect.stringContaining("/namespaces"),
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            namespace: "release-tools",
            scopeKind: scopes[scopeIndex]!.scopeKind,
            ...(scopes[scopeIndex]!.scopeId ? { scopeId: scopes[scopeIndex]!.scopeId } : {}),
          }),
        }),
      );
      expect(f.refresh).toHaveBeenCalledOnce();
      expect(f.message).toHaveBeenLastCalledWith(
        expect.objectContaining({
          kind: "success",
          text: expect.stringContaining("release-tools"),
        }),
      );
    },
  );

  it.each([
    [400, "skill-hub-namespace-invalid", "2–64 lowercase ASCII"],
    [409, "skill-hub-namespace-conflict", "Choose another name"],
    [409, "skill-hub-namespace-in-progress", "already in progress"],
    [403, "forbidden", "Reopen this dialog"],
    [503, "skill-hub-namespace-retry", "Retry with the same namespace and scope"],
  ] as const)(
    "preserves the draft and explains %s/%s before explicit retry",
    async (status, code, text) => {
      const f = setup({ status, code });
      await f.open();
      const namespace = status === 400 ? "admin" : "release-tools";
      f.changeName(namespace);
      f.submit();
      await waitForFast(() =>
        expect(f.dialog().querySelector('[role="alert"]')?.textContent).toContain(text),
      );
      expect(f.name().value).toBe(namespace);
      expect(f.scope().value).toBe("1");
      expect(f.refresh).not.toHaveBeenCalled();
      f.succeed();
      if (status === 400 || code === "skill-hub-namespace-conflict") {
        f.changeName("another-tools");
      }
      f.submit();
      await waitForFast(() => expect(f.dialog()).toBeNull());
      expect(f.fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
    },
  );

  it("records successful creation visibly when refreshing publishing options fails", async () => {
    const f = setup({ refreshFailure: true });
    await f.open();
    f.changeName("release-tools");
    f.submit();
    await waitForFast(() => expect(f.dialog()).toBeNull());
    expect(f.message).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "warning",
        text: expect.stringContaining("Reload the page"),
      }),
    );
    expect(f.fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("offers explicit recovery of the caller's incomplete creation without exposing internal states", async () => {
    const f = setup({
      creations: [
        {
          namespace: "interrupted-tools",
          state: "registry-created",
          scopeKind: "global",
          updatedAt: 1,
        },
      ],
    });
    await f.open();
    expect(f.container.textContent).toContain("Setup is incomplete");
    expect(f.container.textContent).not.toContain("registry-created");
    [...f.dialog().querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Use these values"))!
      .click();
    expect(f.name().value).toBe("interrupted-tools");
    expect(f.scope().value).toBe("1");
    expect(f.fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });

  it("hides creation when the connected integration cannot create namespaces", () => {
    const f = setup();
    render(
      f.controller.renderAction({
        ...config,
        capabilities: { ...config.capabilities!, namespaceCreate: false },
      }),
      f.container,
    );
    expect(f.container.querySelector("button")).toBeNull();
  });

  it("shows scope-loading failures and permits a fresh lookup before creating", async () => {
    const f = setup({ scopeFailure: true });
    f.action().click();
    await waitForFast(() => expect(f.dialog().querySelector('[role="alert"]')).not.toBeNull());
    expect(f.dialog().querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(
      true,
    );
    expect(f.fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    f.succeed();
    [...f.dialog().querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Reload")!
      .click();
    await waitForFast(() => expect(f.scope().value).toBe("1"));
    expect(f.dialog().querySelector('[role="alert"]')).toBeNull();
  });

  it("renders the member creation flow in Korean", async () => {
    await i18n.setLocale("ko");
    await loadPlatformClawLocale();
    const f = setup({ status: 400, code: "skill-hub-namespace-invalid" });
    await f.open();
    expect(f.container.textContent).toContain("네임스페이스 만들기");
    expect(f.container.textContent).toContain("전사 공용");
    expect(f.container.textContent).toContain("팀: Engineering");
    expect(f.dialog().querySelector("small")?.textContent).toContain("영문 소문자(a–z)");
    expect(f.dialog().querySelector("small")?.textContent).toContain("2~64자");
    expect(f.dialog().querySelector("small")?.textContent).toContain("하이픈을 연속해서");
    f.changeName("admin");
    f.submit();
    await waitForFast(() =>
      expect(f.dialog().querySelector('[role="alert"]')?.textContent).toContain("2~64자"),
    );
    expect(f.name().value).toBe("admin");
  });
});
