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
};

async function captureDialogIdentity(component: Locator, kind: "settings" | "progress") {
  const modalHost = component.locator(`[data-${kind}-modal]`);
  const dialog = modalHost.locator("dialog");
  await expect
    .poll(() => dialog.evaluate((element) => (element as HTMLDialogElement).open))
    .toBe(true);
  // Native opening precedes the adapter's next-frame content and focus admission.
  await expect
    .poll(() =>
      modalHost.evaluate((element) => {
        const slot = element.shadowRoot?.querySelector("slot");
        return Boolean(slot && !slot.inert && !slot.hasAttribute("data-focus-pending"));
      }),
    )
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
    // Field focus can scroll the form; compare its flow position rather than the viewport offset.
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
  const copy =
    locale === "en"
      ? {
          basic: "Basic server",
          workLocation: "Work location",
          settings: "Work environment settings",
          connecting: "Connecting to your VM",
          switching: "Switching work location",
          success: "Ready to work",
          failure: "Work location needs attention",
          retry: "Retry work location change",
        }
      : {
          basic: "기본 서버",
          workLocation: "작업 위치",
          settings: "작업 환경 설정",
          connecting: "VM 연결 중",
          switching: "작업 위치 전환 중",
          success: "작업 준비 완료",
          failure: "작업 위치를 확인해 주세요",
          retry: "작업 위치 전환 다시 시도",
        };
  const context = await browser.newContext({
    colorScheme: mode,
    // App language must win even when the browser's date locale differs.
    locale: family === "platformclaw" || locale === "ko" ? "ko-KR" : "en-US",
    reducedMotion: reducedMotion ? "reduce" : "no-preference",
    serviceWorkers: "block",
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const labels = [
    "VM one",
    "VM two with a deliberately long development environment name",
    "VM three",
  ];
  const available = labels.map((label, index) => ({ id: `vm-${index + 1}`, label }));
  type Connection = {
    id: string;
    vmHostId: string;
    vmLabel: string;
    safeConnectLabel: string;
    linuxAccount: string;
    status: string;
    active: boolean;
  };
  const saved: Connection[] = [];
  let assignment:
    | undefined
    | {
        id: string;
        vmHostId: string;
        status: string;
        vmLabel: string;
        safeConnectLabel: string;
        linuxAccount: string;
      };
  let activeTarget = "platform_server";
  let revision = 1;
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  let release: (() => void) | undefined;
  let failNextSwitch = false;
  let retryObserved = false;
  const releasePendingRequest = () => {
    const resolve = release;
    if (!resolve) {
      throw new Error("Expected a pending execution request");
    }
    release = undefined;
    resolve();
  };
  const settings = () => ({
    activeTarget,
    targetRevision: revision,
    credentialStatus: saved.length ? "current" : "missing",
    accountId: "person.one",
    availableVms: available,
    savedVms: saved.map((vm) => ({
      ...vm,
      active: activeTarget === "assigned_vm" && vm.vmHostId === assignment?.vmHostId,
    })),
    assignment,
    codingAgents: [],
  });
  await page.route("**/platformclaw/api/execution**", async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>;
      const pathname = new URL(request.url()).pathname;
      requests.push({ path: pathname, body });
      expect(body.expectedRevision).toBe(revision);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      if (pathname.endsWith("/selection")) {
        expect(body.password).toBe("fixture-password");
        const vm = available.find((item) => item.id === body.vmHostId)!;
        const connection = {
          id: `connection-${vm.id}`,
          vmHostId: vm.id,
          vmLabel: vm.label,
          safeConnectLabel: "Corporate access",
          linuxAccount: "person.one",
          status: "ready",
          active: false,
        };
        saved.push(connection);
        assignment = { ...connection, id: `allocation-${revision}`, status: "ready" };
        activeTarget = "assigned_vm";
      } else {
        expect(pathname.endsWith("/target")).toBe(true);
        if (failNextSwitch && body.target === "assigned_vm") {
          failNextSwitch = false;
          await route.fulfill({ status: 503, json: { error: "Fixture activation failed" } });
          return;
        }
        activeTarget = String(body.target);
        if (activeTarget === "assigned_vm") {
          const connection = saved.find((vm) => vm.id === body.connectionId)!;
          expect(connection).toBeDefined();
          assignment = { ...connection, id: `allocation-${revision}`, status: "ready" };
        }
      }
      revision++;
    }
    await route.fulfill({ json: settings() });
  });
  try {
    await mount(page, locale);
    if (family === "custom") {
      await page.addScriptTag({
        type: "module",
        content: `import { importCustomThemeFromUrl, syncCustomThemeStyleTag } from ${JSON.stringify(`${server.baseUrl}src/app/custom-theme.ts`)}; const theme = await importCustomThemeFromUrl("https://tweakcn.com/themes/connection-proof", async () => new Response(JSON.stringify(${JSON.stringify(createTweakcnThemePayload())}), { headers: { "Content-Type": "application/json" } })); syncCustomThemeStyleTag(theme);`,
      });
      await page.locator("#openclaw-custom-theme").waitFor({ state: "attached" });
    }
    await page.evaluate(
      ({ family: f, mode: m }) => {
        const key = f === "claw" ? "" : f === "knot" ? "openknot" : f;
        document.documentElement.dataset.theme = key ? `${key}${m === "light" ? "-light" : ""}` : m;
        document.documentElement.dataset.themeMode = m;
      },
      { family, mode },
    );
    const component = page.locator("platformclaw-execution-settings");
    const basic = copy.basic;
    const badge = component.locator("[data-action='open']");
    const currentLocation = component.locator("[data-current-location]");
    const currentTarget = currentLocation.locator("[data-current-target]");
    await expect.poll(() => currentTarget.textContent()).toContain(basic);
    expect((await badge.textContent())?.trim()).toBe(copy.workLocation);
    await badge.click();
    await expect
      .poll(() => component.getByRole("dialog", { name: copy.settings, exact: true }).isVisible())
      .toBe(true);
    await captureDialogIdentity(component, "settings");
    expect(
      await currentLocation.locator("[data-target='platform_server']").getAttribute("aria-pressed"),
    ).toBe("true");
    if (locale === "en") {
      expect(await component.locator("[data-settings-modal]").textContent()).not.toMatch(
        /[가-힣]/u,
      );
    }
    async function complete(to: string, from: string, registration = false) {
      const expectFailure = failNextSwitch && !registration;
      await expect.poll(() => typeof release).toBe("function");
      await captureDialogIdentity(component, "progress");
      await assertDialogIdentity(component, "settings");
      await assertLayeredDialogs(component);
      const settingsBox = await settledPanelBox(component, "settings");
      const progressBox = await assertExecutionProgressLayout(component);
      const locationBox = await currentLocationLayoutBox(currentLocation);
      const viewport = page.viewportSize()!;
      expect(progressBox.x).toBeGreaterThanOrEqual(0);
      expect(progressBox.y).toBeGreaterThanOrEqual(0);
      expect(progressBox.x + progressBox.width).toBeLessThanOrEqual(viewport.width);
      expect(progressBox.y + progressBox.height).toBeLessThanOrEqual(viewport.height);
      expect(settingsBox.y).toBeGreaterThanOrEqual(0);
      expect(settingsBox.y + settingsBox.height).toBeLessThanOrEqual(viewport.height);
      expect(await currentTarget.textContent()).toContain(from);
      expect(await badge.getAttribute("aria-busy")).toBe("true");
      const upper = component.locator("[data-progress-modal]");
      expect(
        await upper
          .getByRole("heading", {
            name: registration ? copy.connecting : copy.switching,
            exact: true,
          })
          .isVisible(),
      ).toBe(true);
      if (locale === "en") {
        expect(await upper.textContent()).not.toMatch(/[가-힣]/u);
      }
      if (!registration) {
        await assertExecutionTransfer(component, reducedMotion, { from, to });
      }
      const attempt = requests.at(-1)!;
      releasePendingRequest();
      if (expectFailure) {
        await expect
          .poll(() => upper.locator("[data-progress-panel]").getAttribute("data-phase"))
          .toBe("error");
        expect(await currentTarget.textContent()).toContain(from);
        expect((await badge.textContent())?.trim()).toBe(copy.workLocation);
        expect(
          await upper.getByRole("heading", { name: copy.failure, exact: true }).isVisible(),
        ).toBe(true);
        const retry = upper.getByRole("button", { name: copy.retry, exact: true });
        expect(await retry.isEnabled()).toBe(true);
        await screenshot(page, `multi-vm-${family}-${mode}-failed.png`);
        await retry.click();
        await expect.poll(() => typeof release).toBe("function");
        expect(requests.at(-1)).toEqual(attempt);
        await assertDialogIdentity(component, "progress");
        await assertExecutionTransfer(component, reducedMotion, { from, to });
        retryObserved = true;
        releasePendingRequest();
      }
      await expect.poll(() => currentTarget.textContent()).toContain(to);
      await expect
        .poll(() => upper.locator("[data-progress-panel]").getAttribute("data-phase"))
        .toBe("success");
      expect(
        await upper.getByRole("heading", { name: copy.success, exact: true }).isVisible(),
      ).toBe(true);
      await assertExecutionProgressLayout(component);
      expect(await badge.getAttribute("aria-busy")).toBe("false");
      expect((await badge.textContent())?.trim()).toBe(copy.workLocation);
      await screenshot(page, `multi-vm-${family}-${mode}-${requests.length}.png`);
      await expect
        .poll(() => upper.locator("dialog").evaluate((node) => (node as HTMLDialogElement).open))
        .toBe(false);
      await assertDialogIdentity(component, "settings");
      await assertDialogIdentity(component, "progress", false);
      expect(
        await component.locator("[data-settings-modal] main").evaluate((node) => node.scrollTop),
      ).toBe(0);
      expect(await component.locator("[data-settings-modal] .message--success").count()).toBe(0);
      expect(await currentTarget.getAttribute("role")).toBe("status");
      expect(await currentTarget.getAttribute("aria-live")).toBe("polite");
      if (!registration) {
        const completedBox = await currentLocationLayoutBox(currentLocation);
        for (const coordinate of ["x", "y", "width", "height"] as const) {
          expect(
            Math.abs(completedBox[coordinate] - locationBox[coordinate]),
            `Current location card ${coordinate}`,
          ).toBeLessThan(1);
        }
      }
      expect(
        await component
          .locator("[data-settings-panel]")
          .evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
      ).toBe(true);
    }
    let current = basic;
    for (const vm of available) {
      if (saved.length) {
        await component.locator(`[data-connect-vm='${vm.id}']`).click();
      }
      const form = component.locator("form[data-action='select-vm']");
      await form.locator("select[name='vmHostId']").selectOption(vm.id);
      await form.locator("input[name='linuxAccount']").fill("person.one");
      await form.locator("input[name='password']").fill("fixture-password");
      await form.locator("button[type='submit']").click();
      await complete(vm.label, current, true);
      current = vm.label;
    }
    expect(await component.locator("[data-saved-vm]").count()).toBe(3);
    expect(await currentLocation.locator("[data-target] svg").count()).toBe(4);
    async function switchTo(destination: number) {
      const label = destination < 0 ? basic : labels[destination]!;
      const selector =
        destination < 0
          ? "[data-target='platform_server']"
          : `[data-connection-id='connection-vm-${destination + 1}']`;
      await component.locator(selector).click();
      await complete(label, current);
      current = label;
    }
    for (const destination of [0, 1, 2, 0, -1, 1]) {
      await switchTo(destination);
    }
    // Preserve desktop matrix proof and narrow-screen switching without repeating the full matrix.
    await page.setViewportSize({ width: 390, height: 844 });
    failNextSwitch = family === "platformclaw";
    for (const destination of [0, -1]) {
      await switchTo(destination);
    }
    expect(requests.filter((request) => request.path.endsWith("/selection"))).toHaveLength(3);
    expect(requests.filter((request) => request.path.endsWith("/target"))).toHaveLength(
      family === "platformclaw" ? 9 : 8,
    );
    expect(retryObserved).toBe(family === "platformclaw");
  } finally {
    release?.();
    await context.close();
  }
}
