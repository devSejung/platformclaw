import type { Browser, Locator, Page } from "playwright";
import { expect } from "vitest";
import type { ControlUiE2eServer } from "../test-helpers/control-ui-e2e.ts";
import { createTweakcnThemePayload } from "../test-helpers/custom-theme.ts";
import { assertExecutionTransfer } from "./execution-settings-motion.test-support.ts";

type CaseOptions = {
  browser: Browser;
  server: ControlUiE2eServer;
  family: string;
  mode: "light" | "dark";
  mount: (page: Page, locale: string) => Promise<void>;
  screenshot: (page: Page, name: string) => Promise<void>;
};

type DialogProof = {
  host: Element;
  native: HTMLDialogElement;
  content: Element | null;
  mutations: number;
};
type ProofHost = HTMLElement & {
  executionDialogProof?: Partial<Record<"settings" | "progress", DialogProof>>;
  executionSuccessProof?: {
    heading: string;
    text: string;
    visible: boolean;
    nativeOpen: boolean;
    messageHeight: number;
    stepGap: number;
    settingsBox: { x: number; y: number; width: number; height: number };
    progressBox: { x: number; y: number; width: number; height: number };
  };
};

async function observeProgressSuccess(component: Locator) {
  await component.evaluate((element) => {
    const host = element as ProofHost;
    const root = host.shadowRoot!;
    const observer = new MutationObserver(() => {
      const upper = root.querySelector("[data-progress-modal]");
      const panel = upper?.querySelector<HTMLElement>("[data-progress-panel]");
      const settings = root.querySelector<HTMLElement>("[data-settings-panel]");
      if (panel?.dataset.phase !== "success" || !settings) {
        return;
      }
      const native = upper?.shadowRoot
        ?.querySelector("wa-dialog")
        ?.shadowRoot?.querySelector("dialog");
      const box = panel.getBoundingClientRect();
      const message = panel.querySelector(".progress-message")!.getBoundingClientRect();
      const steps = panel.querySelector("[data-connection-progress]")!.getBoundingClientRect();
      const settingsBox = settings.getBoundingClientRect();
      // Observe the actual short-lived browser state before runner round trips can miss it.
      host.executionSuccessProof = {
        heading: panel.querySelector("h2")?.textContent?.trim() ?? "",
        text: panel.textContent ?? "",
        visible:
          box.width > 0 && box.height > 0 && getComputedStyle(panel).visibility === "visible",
        nativeOpen: native?.open === true,
        messageHeight: message.height,
        stepGap: steps.top - message.bottom,
        settingsBox: {
          x: settingsBox.x,
          y: settingsBox.y,
          width: settingsBox.width,
          height: settingsBox.height,
        },
        progressBox: { x: box.x, y: box.y, width: box.width, height: box.height },
      };
      observer.disconnect();
    });
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["data-phase"],
    });
  });
}

async function captureDialogIdentity(component: Locator, kind: "settings" | "progress") {
  const dialog = component.locator(`[data-${kind}-modal] dialog`);
  await expect
    .poll(() => dialog.evaluate((element) => (element as HTMLDialogElement).open))
    .toBe(true);
  await component.evaluate((element, dialogKind) => {
    const host = element as ProofHost;
    const modal = host.shadowRoot?.querySelector(`[data-${dialogKind}-modal]`);
    const native = modal?.shadowRoot
      ?.querySelector("wa-dialog")
      ?.shadowRoot?.querySelector("dialog");
    if (!modal || !native) {
      throw new Error(`Missing ${dialogKind} native dialog`);
    }
    const proof: DialogProof = {
      host: modal,
      native,
      content: modal.querySelector(
        dialogKind === "settings" ? ".panel" : "[data-connection-progress]",
      ),
      mutations: 0,
    };
    new MutationObserver((records) => {
      proof.mutations += records.length;
    }).observe(native, {
      attributes: true,
      attributeFilter: ["open"],
    });
    (host.executionDialogProof ??= {})[dialogKind] = proof;
  }, kind);
}

async function assertDialogIdentity(
  component: Locator,
  kind: "settings" | "progress",
  open = true,
) {
  const state = await component.evaluate(
    (element, { dialogKind }) => {
      const host = element as ProofHost;
      const proof = host.executionDialogProof?.[dialogKind];
      const modal = host.shadowRoot?.querySelector(`[data-${dialogKind}-modal]`);
      const native = modal?.shadowRoot
        ?.querySelector("wa-dialog")
        ?.shadowRoot?.querySelector("dialog");
      return {
        hostSame: modal === proof?.host,
        nativeSame: native === proof?.native,
        contentSame:
          modal?.querySelector(
            dialogKind === "settings" ? ".panel" : "[data-connection-progress]",
          ) === proof?.content,
        open: native?.open,
        modal: native?.matches(":modal"),
        shows: Number(native?.dataset.executionShowCalls),
        closes: Number(native?.dataset.executionCloseCalls ?? 0),
        mutations: proof?.mutations,
      };
    },
    { dialogKind: kind },
  );
  expect(state).toEqual({
    hostSame: true,
    nativeSame: true,
    contentSame: true,
    open,
    modal: open,
    shows: 1,
    closes: open ? 0 : 1,
    mutations: open ? 0 : 1,
  });
}

async function assertLayeredDialogs(component: Locator) {
  const topology = await component.evaluate((element) => {
    const proof = (element as ProofHost).executionDialogProof;
    if (!proof?.settings || !proof.progress) {
      throw new Error("Both modal layers must exist");
    }
    const upperBackdrop = getComputedStyle(proof.progress.native, "::backdrop");
    const lowerBackdrop = getComputedStyle(proof.settings.native, "::backdrop");
    return {
      siblings: proof.settings.host.parentNode === proof.progress.host.parentNode,
      settingsOpen: proof.settings.native.open,
      progressOpen: proof.progress.native.open,
      upperBackground: upperBackdrop.backgroundColor,
      upperImage: upperBackdrop.backgroundImage,
      upperFilter: upperBackdrop.backdropFilter,
      lowerFilter: lowerBackdrop.backdropFilter,
      lowerHasScrim:
        lowerBackdrop.backgroundColor !== "rgba(0, 0, 0, 0)" ||
        lowerBackdrop.backgroundImage !== "none",
    };
  });
  expect(topology).toEqual({
    siblings: true,
    settingsOpen: true,
    progressOpen: true,
    upperBackground: "rgba(0, 0, 0, 0)",
    upperImage: "none",
    upperFilter: "none",
    lowerFilter: "blur(4px)",
    lowerHasScrim: true,
  });
}

async function settledPanelBox(component: Locator, kind: "settings" | "progress") {
  const modal = component.locator(`[data-${kind}-modal]`);
  // Measure layout after the native entrance transition, not its temporary scale transform.
  await modal.locator("dialog").evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations({ subtree: true })
        .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
  const box = await modal
    .locator(kind === "settings" ? "[data-settings-panel]" : "[data-progress-panel]")
    .boundingBox();
  if (!box) {
    throw new Error(`Missing ${kind} panel bounds`);
  }
  return box;
}

async function assertPanelBox(
  component: Locator,
  kind: "settings" | "progress",
  expected: NonNullable<Awaited<ReturnType<Locator["boundingBox"]>>>,
) {
  const actual = await settledPanelBox(component, kind);
  for (const coordinate of ["x", "y", "width", "height"] as const) {
    expect(
      Math.abs(actual[coordinate] - expected[coordinate]),
      `${kind} panel ${coordinate}`,
    ).toBeLessThan(1);
  }
}

export async function assertExecutionProgressLayout(
  component: Locator,
  expected?: Awaited<ReturnType<typeof settledPanelBox>>,
) {
  const box = await settledPanelBox(component, "progress");
  const layout = await component.locator("[data-progress-panel]").evaluate((panel) => {
    const message = panel.querySelector(".progress-message")!.getBoundingClientRect();
    const steps = panel.querySelector("[data-connection-progress]")!.getBoundingClientRect();
    const prompt = panel.querySelector("[data-activation-offer] p")?.getBoundingClientRect();
    const buttons = panel.querySelector("[data-activation-offer] .row")?.getBoundingClientRect();
    return {
      messageHeight: message.height,
      stepGap: steps.top - message.bottom,
      offerGap: prompt && buttons ? buttons.top - prompt.bottom : null,
      buttonBottom: buttons?.bottom ?? null,
    };
  });
  expect(box.height).toBeLessThanOrEqual(324);
  expect(layout.messageHeight).toBeLessThanOrEqual(48);
  expect(layout.stepGap).toBeGreaterThanOrEqual(0);
  expect(layout.stepGap).toBeLessThanOrEqual(16);
  if (layout.offerGap !== null && layout.buttonBottom !== null) {
    expect(layout.offerGap).toBeGreaterThanOrEqual(11);
    expect(layout.buttonBottom).toBeLessThanOrEqual(box.y + box.height);
    expect(box.y + box.height - layout.buttonBottom).toBeLessThanOrEqual(48);
  }
  if (expected) {
    for (const coordinate of ["x", "y", "width", "height"] as const) {
      expect(
        Math.abs(box[coordinate] - expected[coordinate]),
        `Progress ${coordinate}`,
      ).toBeLessThan(1);
    }
  }
  return box;
}

function currentLocationLayoutBox(card: Locator) {
  return card.evaluate((element) => {
    const main = element.closest("main");
    if (!main) {
      throw new Error("Current location card must belong to the settings scroll area");
    }
    const { x, y, width, height } = element.getBoundingClientRect();
    // Native field focus may scroll the form; banner insertion still shifts this flow position.
    return { x, y: y + main.scrollTop, width, height };
  });
}

export async function runExecutionProgressCase({
  browser,
  server,
  family,
  mode,
  mount,
  screenshot,
}: CaseOptions): Promise<void> {
  const locale = mode === "light" ? "en" : "ko";
  const reducedMotion = family === "custom";
  const failActivation = family === "platformclaw";
  const copy =
    locale === "en"
      ? {
          basic: "Basic server",
          vm: "Development VM",
          workLocation: "Work location",
          settings: "Work environment settings",
          connect: "Connect and use VM",
          connection: "Connect and prepare workspace",
          activation: "Use this VM as the work location",
          retry: "Retry work location change",
          progressLabel: "Changing work location",
          connectingTitle: "Connecting to your VM",
          switchingTitle: "Switching work location",
          successTitle: "Ready to work",
          failureTitle: "Work location needs attention",
        }
      : {
          basic: "기본 서버",
          vm: "개발 VM",
          workLocation: "작업 위치",
          settings: "작업 환경 설정",
          connect: "연결하고 사용",
          connection: "VM 연결 및 작업 공간 준비",
          activation: "이 VM을 작업 위치로 사용",
          retry: "작업 위치 전환 다시 시도",
          progressLabel: "작업 위치 전환",
          connectingTitle: "VM 연결 중",
          switchingTitle: "작업 위치 전환 중",
          successTitle: "작업 준비 완료",
          failureTitle: "작업 위치를 확인해 주세요",
        };
  const context = await browser.newContext({
    colorScheme: mode,
    // App language must also win when the browser's date locale differs.
    locale: family === "platformclaw" || locale === "ko" ? "ko-KR" : "en-US",
    reducedMotion: reducedMotion ? "reduce" : "no-preference",
    serviceWorkers: "block",
    viewport: { width: 390, height: 844 },
  });
  await context.addInitScript(() => {
    const showModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal")
      ?.value as HTMLDialogElement["showModal"];
    const close = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close")
      ?.value as HTMLDialogElement["close"];
    HTMLDialogElement.prototype.showModal = function () {
      this.dataset.executionShowCalls = String(Number(this.dataset.executionShowCalls ?? 0) + 1);
      showModal.call(this);
    };
    HTMLDialogElement.prototype.close = function (returnValue) {
      this.dataset.executionCloseCalls = String(Number(this.dataset.executionCloseCalls ?? 0) + 1);
      close.call(this, returnValue);
    };
  });
  const page = await context.newPage();
  let releaseSelection = () => {};
  let releaseActivation = () => {};
  let releaseRetry = () => {};
  let releaseReverse = () => {};
  const selectionGate = new Promise<void>((resolve) => {
    releaseSelection = resolve;
  });
  const activationGate = new Promise<void>((resolve) => {
    releaseActivation = resolve;
  });
  const retryGate = new Promise<void>((resolve) => {
    releaseRetry = resolve;
  });
  const reverseGate = new Promise<void>((resolve) => {
    releaseReverse = resolve;
  });
  let activationAttempts = 0;
  const requests: Array<{ path: string; body: unknown }> = [];
  const initialSettings = {
    activeTarget: "platform_server",
    targetRevision: 3,
    credentialStatus: "missing",
    accountId: "person.one",
    availableVms: [{ id: "development", label: "Development VM" }],
    codingAgents: [],
  };
  const selectedSettings = {
    ...initialSettings,
    targetRevision: 4,
    credentialStatus: "current",
    assignment: {
      id: "allocation-development",
      vmHostId: "development",
      status: "ready",
      vmLabel: "Development VM",
      safeConnectLabel: "Corporate access",
      linuxAccount: "person.one",
      remoteWorkspaceDir: "/users/person.one/.platformclaw/workspace",
      lastConnectionSucceededAt: 1_787_642_400_000,
    },
  };
  const activeSettings = {
    ...selectedSettings,
    activeTarget: "assigned_vm",
    targetRevision: 5,
  };
  let currentSettings: typeof initialSettings | typeof selectedSettings = initialSettings;

  await page.route("**/platformclaw/api/execution**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "POST") {
      requests.push({ path: pathname, body: request.postDataJSON() });
      if (pathname.endsWith("/selection")) {
        await selectionGate;
        currentSettings = selectedSettings;
      } else if (
        pathname.endsWith("/target") &&
        request.postDataJSON().target === "platform_server"
      ) {
        await reverseGate;
        currentSettings = { ...selectedSettings, targetRevision: 6 };
      } else if (pathname.endsWith("/target")) {
        activationAttempts += 1;
        await (activationAttempts === 1 ? activationGate : retryGate);
        if (failActivation && activationAttempts === 1) {
          await route.fulfill({ status: 503, json: { error: "Fixture activation failed" } });
          return;
        }
        currentSettings = activeSettings;
      } else {
        throw new Error(`Unexpected execution mutation: ${pathname}`);
      }
    }
    await route.fulfill({ json: currentSettings });
  });

  try {
    await mount(page, locale);
    if (family === "custom") {
      // Browser-owned module source avoids Vitest rewriting imports inside evaluate callbacks.
      await page.addScriptTag({
        type: "module",
        content: `
              import { importCustomThemeFromUrl, syncCustomThemeStyleTag } from ${JSON.stringify(`${server.baseUrl}src/app/custom-theme.ts`)};
              const theme = await importCustomThemeFromUrl(
                "https://tweakcn.com/themes/connection-proof",
                async () => new Response(JSON.stringify(${JSON.stringify(createTweakcnThemePayload())}), {
                  headers: { "Content-Type": "application/json" },
                }),
              );
              syncCustomThemeStyleTag(theme);
            `,
      });
      await page.locator("#openclaw-custom-theme").waitFor({ state: "attached" });
    }
    await page.evaluate(
      ({ family: themeFamily, mode: themeMode }) => {
        const resolvedFamily =
          themeFamily === "claw" ? "" : themeFamily === "knot" ? "openknot" : themeFamily;
        const resolvedTheme = resolvedFamily
          ? `${resolvedFamily}${themeMode === "light" ? "-light" : ""}`
          : themeMode;
        document.documentElement.dataset.theme = resolvedTheme;
        document.documentElement.dataset.themeMode = themeMode;
      },
      { family, mode },
    );
    const component = page.locator("platformclaw-execution-settings");
    const badge = component.locator("[data-action='open']");
    const currentLocation = component.locator("[data-current-location]");
    const currentTarget = currentLocation.locator("[data-current-target]");
    await expect.poll(() => currentTarget.textContent()).toContain(copy.basic);
    expect((await badge.textContent())?.trim()).toBe(copy.workLocation);
    await badge.click();
    await expect
      .poll(() => component.getByRole("dialog", { name: copy.settings, exact: true }).isVisible())
      .toBe(true);
    await captureDialogIdentity(component, "settings");
    const settingsPanelBox = await settledPanelBox(component, "settings");
    const currentLocationBox = await currentLocationLayoutBox(currentLocation);
    expect(await currentTarget.textContent()).toContain(copy.basic);
    expect(await currentLocation.locator("[data-target] svg").count()).toBe(2);
    expect(
      await currentLocation.locator("[data-target='platform_server']").getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      await currentLocation.locator("[data-target='assigned_vm']").getAttribute("aria-pressed"),
    ).toBe("false");
    if (locale === "en") {
      expect(await component.locator("[data-settings-modal]").textContent()).not.toMatch(
        /[가-힣]/u,
      );
    }
    const form = component.locator("form[data-action='select-vm']");
    expect(await component.locator("[data-vm-connection]").count()).toBe(1);
    expect(
      await component.locator("[data-vm-connection] form[data-action='select-vm']").isVisible(),
    ).toBe(true);
    await form.locator("select[name='vmHostId']").selectOption("development");
    await form.locator("input[name='linuxAccount']").fill("person.one");
    await form.locator("input[name='password']").fill("test-password");
    await component.getByRole("button", { name: copy.connect, exact: true }).click();

    const progress = component.locator("[data-connection-progress]");
    await expect.poll(() => requests.length).toBe(1);
    expect(requests[0]).toEqual({
      path: "/platformclaw/api/execution/selection",
      body: {
        vmHostId: "development",
        linuxAccount: "person.one",
        password: "test-password",
      },
    });
    await expect.poll(() => progress.getAttribute("role")).toBe("status");
    await captureDialogIdentity(component, "progress");
    await assertDialogIdentity(component, "settings");
    await assertDialogIdentity(component, "progress");
    await assertLayeredDialogs(component);
    await assertPanelBox(component, "settings", settingsPanelBox);
    const progressPanelBox = await assertExecutionProgressLayout(component);
    expect((await progress.locator("[data-step='connection']").textContent())?.trim()).toBe(
      copy.connection,
    );
    expect((await progress.locator("[data-step='activation']").textContent())?.trim()).toBe(
      copy.activation,
    );
    const upper = component.locator("[data-progress-modal]");
    expect(
      await component.getByRole("dialog", { name: copy.progressLabel, exact: true }).isVisible(),
    ).toBe(true);
    expect(
      await upper.getByRole("heading", { name: copy.connectingTitle, exact: true }).isVisible(),
    ).toBe(true);
    if (locale === "en") {
      expect(await upper.textContent()).not.toMatch(/[가-힣]/u);
    }
    await expect
      .poll(() => progress.locator("[data-step='connection']").getAttribute("data-state"))
      .toBe("active");
    expect(await progress.locator("[data-step='activation']").getAttribute("data-state")).toBe(
      "pending",
    );
    expect((await progress.locator("[data-state='active']").textContent())?.trim()).toBeTruthy();
    expect(await progress.locator("[data-state='active']").isVisible()).toBe(true);
    expect(await component.locator("input:not(:disabled), select:not(:disabled)").count()).toBe(0);
    expect(await component.locator("[data-action='close']").isEnabled()).toBe(true);
    expect(await badge.getAttribute("aria-busy")).toBe("true");
    const animation = await progress
      .locator("[data-state='active'] .step-dot")
      .evaluate((element) => getComputedStyle(element).animationName);
    expect(animation === "none").toBe(reducedMotion);
    const progressBox = await progress.boundingBox();
    expect(progressBox).not.toBeNull();
    expect(progressBox!.x).toBeGreaterThanOrEqual(0);
    expect(progressBox!.x + progressBox!.width).toBeLessThanOrEqual(390);
    expect(progressBox!.y + progressBox!.height).toBeLessThanOrEqual(844);
    expect(progressPanelBox.y).toBeGreaterThanOrEqual(0);
    expect(progressPanelBox.y + progressPanelBox.height).toBeLessThanOrEqual(844);
    const colors = await progress.evaluate((element) => {
      const root = getComputedStyle(document.documentElement);
      const probe = document.createElement("span");
      probe.style.color = "var(--text)";
      element.append(probe);
      const expectedText = getComputedStyle(probe).color;
      probe.remove();
      return {
        text: getComputedStyle(element).color,
        expectedText,
        run: root.getPropertyValue("--run").trim(),
        theme: document.documentElement.dataset.theme,
      };
    });
    expect(colors.text).toBe(colors.expectedText);
    expect(colors.run).not.toBe("");
    expect(colors.theme).toContain(
      family === "claw" ? mode : family === "knot" ? "openknot" : family,
    );
    await screenshot(page, `connect-${family}-${mode}-01-connection.png`);

    releaseSelection();
    await expect.poll(() => requests.length).toBe(2);
    expect(requests[1]).toEqual({
      path: "/platformclaw/api/execution/target",
      body: { target: "assigned_vm", expectedRevision: 4 },
    });
    await expect
      .poll(() => progress.locator("[data-step='connection']").getAttribute("data-state"))
      .toBe("complete");
    expect(await progress.locator("[data-step='activation']").getAttribute("data-state")).toBe(
      "active",
    );
    expect((await progress.locator("[data-state='active']").textContent())?.trim()).toBeTruthy();
    expect(await badge.getAttribute("aria-busy")).toBe("true");
    await assertExecutionTransfer(component, "assigned_vm", reducedMotion, copy);
    await assertDialogIdentity(component, "settings");
    await assertDialogIdentity(component, "progress");
    await assertPanelBox(component, "settings", settingsPanelBox);
    await assertExecutionProgressLayout(component, progressPanelBox);
    expect(
      await upper.getByRole("heading", { name: copy.switchingTitle, exact: true }).isVisible(),
    ).toBe(true);
    if (locale === "en") {
      expect(await upper.textContent()).not.toMatch(/[가-힣]/u);
    }
    await screenshot(page, `connect-${family}-${mode}-02-activation.png`);

    await observeProgressSuccess(component);
    releaseActivation();
    if (failActivation) {
      await expect
        .poll(() => progress.locator("[data-step='activation']").getAttribute("data-state"))
        .toBe("failed");
      expect(await progress.locator("[data-step='connection']").getAttribute("data-state")).toBe(
        "complete",
      );
      expect(await upper.getByRole("button", { name: copy.retry, exact: true }).isEnabled()).toBe(
        true,
      );
      await assertDialogIdentity(component, "settings");
      await assertDialogIdentity(component, "progress");
      await assertPanelBox(component, "settings", settingsPanelBox);
      await assertPanelBox(component, "progress", progressPanelBox);
      expect(
        await upper.getByRole("heading", { name: copy.failureTitle, exact: true }).isVisible(),
      ).toBe(true);
      if (locale === "en") {
        expect(await upper.textContent()).not.toMatch(/[가-힣]/u);
      }
      await screenshot(page, `connect-${family}-${mode}-03-failed.png`);
      await upper.getByRole("button", { name: copy.retry, exact: true }).click();
      await expect.poll(() => requests.length).toBe(3);
      expect(requests[2]).toEqual({
        path: "/platformclaw/api/execution/target",
        body: { target: "assigned_vm", expectedRevision: 4 },
      });
      expect(requests.filter((item) => item.path.endsWith("/selection"))).toHaveLength(1);
      await expect
        .poll(() => progress.locator("[data-step='activation']").getAttribute("data-state"))
        .toBe("active");
      await assertDialogIdentity(component, "progress");
      releaseRetry();
    }
    await expect.poll(() => currentTarget.textContent()).toContain(copy.vm);
    await expect
      .poll(() =>
        component.evaluate((element) => (element as ProofHost).executionSuccessProof?.heading),
      )
      .toBe(copy.successTitle);
    const success = await component.evaluate(
      (element) => (element as ProofHost).executionSuccessProof,
    );
    expect(success?.visible).toBe(true);
    expect(success?.nativeOpen).toBe(true);
    expect(success?.messageHeight).toBeLessThanOrEqual(48);
    expect(success?.stepGap).toBeGreaterThanOrEqual(0);
    expect(success?.stepGap).toBeLessThanOrEqual(16);
    expect(success?.progressBox.height).toBeLessThanOrEqual(324);
    for (const coordinate of ["x", "y", "width", "height"] as const) {
      expect(
        Math.abs(success!.settingsBox[coordinate] - settingsPanelBox[coordinate]),
        `Success settings panel ${coordinate}`,
      ).toBeLessThan(1);
      expect(
        Math.abs(success!.progressBox[coordinate] - progressPanelBox[coordinate]),
        `Success progress panel ${coordinate}`,
      ).toBeLessThan(1);
    }
    if (locale === "en") {
      expect(success?.text).not.toMatch(/[가-힣]/u);
    }
    expect(requests).toHaveLength(failActivation ? 3 : 2);
    expect(await component.locator("[data-action='confirm-switch']").count()).toBe(0);
    await expect.poll(() => badge.getAttribute("aria-busy")).not.toBe("true");
    expect((await badge.textContent())?.trim()).toBe(copy.workLocation);
    await expect
      .poll(() =>
        upper.locator("dialog").evaluate((element) => (element as HTMLDialogElement).open),
      )
      .toBe(false);
    await assertDialogIdentity(component, "settings");
    await assertDialogIdentity(component, "progress", false);
    expect(
      await component.getByRole("dialog", { name: copy.settings, exact: true }).isVisible(),
    ).toBe(true);
    expect(
      await component
        .locator("[data-settings-modal] main")
        .evaluate((element) => element.scrollTop),
    ).toBe(0);
    const completedLocationBox = await currentLocationLayoutBox(currentLocation);
    for (const coordinate of ["x", "y", "width", "height"] as const) {
      expect(
        Math.abs(completedLocationBox[coordinate] - currentLocationBox[coordinate]),
        `Current location card ${coordinate}`,
      ).toBeLessThan(1);
    }
    expect(await component.locator("[data-settings-modal] .message--success").count()).toBe(0);
    expect(
      await currentLocation.locator("[data-target='platform_server']").getAttribute("aria-pressed"),
    ).toBe("false");
    const selectedTile = currentLocation.locator("[data-target='assigned_vm']");
    expect(await selectedTile.getAttribute("aria-pressed")).toBe("true");
    expect(await selectedTile.textContent()).toContain(copy.vm);
    expect(await currentTarget.textContent()).toContain(copy.vm);
    expect(await currentTarget.getAttribute("role")).toBe("status");
    expect(await currentTarget.getAttribute("aria-live")).toBe("polite");
    expect(await component.locator("[data-vm-connection]").count()).toBe(1);
    expect(
      await component
        .locator("[data-vm-connection] form[data-action='update-credential'] [data-password]")
        .isVisible(),
    ).toBe(true);
    expect(await component.locator(".credentials-details").count()).toBe(0);
    if (locale === "en") {
      expect(await component.locator("[data-settings-modal]").textContent()).not.toMatch(
        /[가-힣]/u,
      );
    }
    await screenshot(page, `connect-${family}-${mode}-03-active.png`);
    if (family === "platformclaw" && mode === "light") {
      await component.locator("[data-target='platform_server']").click();
      await assertExecutionTransfer(component, "platform_server", false, copy);
      await expect
        .poll(() => requests.at(-1)?.body)
        .toEqual({ target: "platform_server", expectedRevision: 5 });
      releaseReverse();
      await expect
        .poll(() => upper.locator("dialog").evaluate((node) => (node as HTMLDialogElement).open))
        .toBe(false);
      expect(await currentTarget.textContent()).toContain(copy.basic);
    }
  } finally {
    releaseSelection();
    releaseActivation();
    releaseRetry();
    releaseReverse();
    await context.close();
  }
}
