import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const suite =
  canRunPlaywrightChromium(executablePath) ||
  process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM !== "1"
    ? describe
    : describe.skip;
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.join(process.cwd(), ".artifacts/control-ui-e2e/platformclaw-vm-admin");
let browser: Browser;
let server: ControlUiE2eServer;
type Environment = { pathPrepend: string[]; variables: Record<string, string> };
type Host = {
  id: string;
  endpointId: string;
  label: string;
  targetAddress: string;
  status: string;
  executionEnvironment?: Environment;
};

async function screenshot(page: Page, name: string) {
  if (captureProof) {
    await mkdir(proofDir, { recursive: true });
    await page.screenshot({ animations: "disabled", path: path.join(proofDir, name) });
  }
}

async function closed(component: Locator) {
  await expect
    .poll(() =>
      component
        .locator("[data-admin-modal] dialog")
        .evaluate((dialog) => (dialog as HTMLDialogElement).open),
    )
    .toBe(false);
}

async function fits(dialog: Locator, viewport: { width: number; height: number }) {
  const box = await dialog.locator(".admin-dialog").boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
  expect(
    await dialog
      .locator(".admin-dialog")
      .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
  ).toBe(true);
}

async function observeSuccess(component: Locator) {
  await component.evaluate((host) => {
    const element = host as HTMLElement & { vmSuccessProof?: { open: boolean; visible: boolean } };
    const root = element.shadowRoot!;
    const observer = new MutationObserver(() => {
      const panel = root.querySelector<HTMLElement>("[data-operation-phase='success']");
      if (!panel) {
        return;
      }
      const native = root
        .querySelector("[data-admin-modal]")
        ?.shadowRoot?.querySelector("wa-dialog")
        ?.shadowRoot?.querySelector("dialog");
      element.vmSuccessProof = {
        open: native?.open === true,
        visible: panel.getBoundingClientRect().height > 0,
      };
      observer.disconnect();
    });
    observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-operation-phase"],
    });
  });
}

async function workingLayout(
  modal: Locator,
  viewport: { width: number; height: number },
  forms = 0,
) {
  await fits(modal, viewport);
  const layout = await modal.evaluate((host) => {
    const panel = host.querySelector<HTMLElement>(".admin-dialog")!;
    const progress = panel.querySelector<HTMLElement>("[data-admin-progress]")!;
    const heading = panel.querySelector<HTMLElement>(".dialog-heading")!;
    return {
      forms: [...panel.querySelectorAll("form")].map((form) => ({
        display: getComputedStyle(form).display,
        height: form.getBoundingClientRect().height,
      })),
      progress: progress.getBoundingClientRect().toJSON(),
      heading: heading.getBoundingClientRect().toJSON(),
      panel: panel.getBoundingClientRect().toJSON(),
    };
  });
  expect(layout.forms).toHaveLength(forms);
  expect(layout.forms.every((form) => form.display === "none" && form.height === 0)).toBe(true);
  expect(layout.progress.height).toBeGreaterThan(0);
  expect(layout.progress.top).toBeGreaterThanOrEqual(layout.heading.bottom);
  expect(layout.progress.bottom).toBeLessThanOrEqual(layout.panel.bottom);
}

suite("PlatformClaw VM administration", () => {
  beforeAll(async () => {
    server = await startControlUiE2eServer(undefined, { source: true });
    browser = await chromium.launch({ executablePath });
  });
  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it.each([
    {
      name: "desktop-en-light",
      locale: "en",
      mode: "light",
      viewport: { width: 1360, height: 900 },
      reduced: false,
    },
    {
      name: "mobile-ko-dark",
      locale: "ko",
      mode: "dark",
      viewport: { width: 390, height: 844 },
      reduced: true,
    },
  ])(
    "keeps overview, connection recovery, VM edits and operation progress usable on $name",
    async ({ name, locale, mode, viewport, reduced }) => {
      const context = await browser.newContext({
        locale: locale === "ko" ? "ko-KR" : "en-US",
        viewport,
        serviceWorkers: "block",
        reducedMotion: reduced ? "reduce" : "no-preference",
      });
      const page = await context.newPage();
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(String(error)));
      const snapshot = {
        endpoints: [
          {
            id: "endpoint-1",
            label: "Corporate access",
            host: "safeconnect.example.test",
            port: 44422,
            adDomain: "example.test",
            status: "disabled",
            hostKeyFingerprint: "SHA256:verified",
          },
          {
            id: "endpoint-pending",
            label: "Pending connection",
            host: "pending.example.test",
            port: 44422,
            adDomain: "example.test",
            status: "pending",
            hostKeyFingerprint: "",
          },
        ],
        hosts: [
          {
            id: "host-1",
            endpointId: "endpoint-1",
            label: "Development VM",
            targetAddress: "192.0.2.10",
            status: "disabled",
          },
        ] as Host[],
        agents: [{ accountId: "person.one", agentId: "person_one", displayName: "Person One" }],
        allocations: [],
        auditEvents: [
          {
            id: "audit-1",
            eventType: "safeconnect.host-key.approved",
            targetType: "safeconnect-endpoint",
            targetId: "endpoint-1",
            createdAt: 1_787_642_400_000,
          },
        ],
      };
      const mutations: Array<{ action: string; body: unknown }> = [];
      let failRefresh = false;
      let failEnvironment = true;
      const releases = new Set<() => void>();
      let pending: { action: string; promise: Promise<void>; release: () => void } | undefined;
      const hold = (action: string) => {
        let release!: () => void;
        const promise = new Promise<void>((resolve) => {
          release = () => {
            releases.delete(release);
            resolve();
          };
        });
        releases.add(release);
        pending = { action, promise, release };
        return release;
      };
      await page.route("**/platformclaw/api/admin/vm", async (route) => {
        if (route.request().method() !== "POST") {
          if (failRefresh) {
            failRefresh = false;
            await route.fulfill({
              status: 503,
              json: { error: "Fixture administration unavailable" },
            });
            return;
          }
          await route.fulfill({ json: snapshot });
          return;
        }
        const body = route.request().postDataJSON() as {
          action: string;
          label?: string;
          targetAddress?: string;
          executionEnvironment?: Environment;
        };
        mutations.push({ action: body.action, body });
        if (pending?.action === body.action) {
          const gate = pending;
          pending = undefined;
          await gate.promise;
        }
        if (body.action === "enable-endpoint") {
          snapshot.endpoints[0]!.status = "active";
        } else if (body.action === "update-host") {
          snapshot.hosts[0]!.label = body.label!;
          snapshot.hosts[0]!.targetAddress = body.targetAddress!;
        } else if (body.action === "enable-host") {
          snapshot.hosts[0]!.status = "active";
        } else if (body.action === "update-host-execution-environment") {
          if (failEnvironment) {
            failEnvironment = false;
            await route.fulfill({
              status: 503,
              json: { error: "Fixture environment unavailable" },
            });
            return;
          }
          snapshot.hosts[0]!.executionEnvironment = body.executionEnvironment;
        }
        await route.fulfill({ json: snapshot });
      });
      try {
        await page.goto(new URL("sw.js", server.baseUrl).href);
        await page.setContent(
          `<!doctype html><html><head><link rel="stylesheet" href="${server.baseUrl}src/styles.css"></head><body></body></html>`,
        );
        await page.evaluate(
          ({ language, themeMode }) => {
            localStorage.setItem("openclaw.i18n.locale", language);
            document.documentElement.dataset.theme =
              themeMode === "light" ? "platformclaw-light" : "platformclaw";
            document.documentElement.dataset.themeMode = themeMode;
          },
          { language: locale, themeMode: mode },
        );
        await page.addScriptTag({
          type: "module",
          url: `${server.baseUrl}src/platformclaw/vm-administration.ts`,
        });
        await page.evaluate(async () => {
          await customElements.whenDefined("platformclaw-vm-administration");
          document.body.replaceChildren(document.createElement("platformclaw-vm-administration"));
        });
        const component = page.locator("platformclaw-vm-administration");
        const modal = component.locator("[data-admin-modal]");
        await expect.poll(() => component.locator("[data-refresh]").isEnabled()).toBe(true);
        expect(
          await component.locator("[data-admin-tab='hosts']").getAttribute("aria-selected"),
        ).toBe("true");
        expect(await component.locator("[role='tab']").count()).toBe(4);
        expect(await component.locator("form").count()).toBe(0);
        await closed(component);
        expect(
          await component
            .locator("[data-host-id='host-1'] [data-mutation='enable-host']")
            .isDisabled(),
        ).toBe(true);
        expect(await component.textContent()).not.toContain("platformClaw.vmAdmin.");
        await screenshot(page, `${name}-01-overview.png`);
        await component.locator("[data-admin-tab='endpoints']").click();
        await expect
          .poll(() =>
            component.locator("[data-endpoint-id='endpoint-pending'] .badge").textContent(),
          )
          .toBe(locale === "ko" ? "호스트 키 승인 필요" : "Host key approval required");
        expect(await component.textContent()).not.toContain("platformClaw.vmAdmin.");
        await component.locator("[data-add-endpoint]").click();
        await modal.locator("form[data-endpoint-probe] [name='host']").waitFor();
        await fits(modal, viewport);
        await modal.locator(".dialog-heading [data-close-admin]").click();
        await closed(component);
        const enableEndpoint = component.locator(
          "[data-endpoint-id='endpoint-1'] [data-mutation='enable-endpoint']",
        );
        await enableEndpoint.click();
        await modal.locator("[data-cancel-mutation]").click();
        await closed(component);
        expect(mutations).toEqual([]);
        await enableEndpoint.click();
        await component.evaluate((element) => {
          element.remove();
          document.body.append(element);
        });
        await expect.poll(() => component.locator("[data-refresh]").isEnabled()).toBe(true);
        await closed(component);
        expect(await component.locator("[data-confirm-mutation]").count()).toBe(0);
        await component.locator("[data-admin-tab='endpoints']").click();
        await enableEndpoint.click();
        const native = await modal.locator("dialog").elementHandle();
        expect(native).not.toBeNull();
        const releaseStatus = hold("enable-endpoint");
        await modal.locator("[data-confirm-mutation]").click();
        await modal
          .locator("[data-operation-phase='working'] [data-stage='change-status']")
          .waitFor();
        expect(await component.locator("[data-refresh]").isDisabled()).toBe(true);
        expect(await modal.locator("[data-close-admin]").isEnabled()).toBe(true);
        expect(await modal.locator("[data-admin-progress]").getAttribute("role")).toBe("status");
        expect(await modal.locator("[data-admin-progress] svg").count()).toBeGreaterThan(0);
        const animated = await modal
          .locator("[data-admin-progress]")
          .evaluate((element) =>
            element
              .getAnimations({ subtree: true })
              .some((animation) => animation.playState === "running"),
          );
        expect(animated).toBe(!reduced);
        expect(
          await modal
            .locator("dialog")
            .evaluate((current, previous) => current === previous, native),
        ).toBe(true);
        await workingLayout(modal, viewport);
        await observeSuccess(component);
        releaseStatus();
        await expect
          .poll(() =>
            component.evaluate(
              (host) =>
                (host as HTMLElement & { vmSuccessProof?: { open: boolean; visible: boolean } })
                  .vmSuccessProof,
            ),
          )
          .toEqual({ open: true, visible: true });
        await closed(component);
        expect(
          await modal
            .locator("dialog")
            .evaluate((current, previous) => current === previous, native),
        ).toBe(true);
        expect(
          await component
            .locator("[data-endpoint-id='endpoint-1'] [data-mutation='disable-endpoint']")
            .isEnabled(),
        ).toBe(true);
        await component.locator("[data-admin-tab='hosts']").click();
        await component.locator("[data-add-host]").click();
        expect(
          await modal.locator("form[data-action='hosts'] [name='endpointId']").inputValue(),
        ).toBe("endpoint-1");
        expect(
          await modal.locator("form[data-action='hosts'] details").getAttribute("open"),
        ).toBeNull();
        await fits(modal, viewport);
        await modal.locator(".dialog-heading [data-close-admin]").click();
        await closed(component);
        await component.locator("[data-edit-host='host-1']").click();
        const hostForm = modal.locator("form[data-action='update-host']");
        await hostForm.locator("[name='targetAddress']").fill("192.0.2.11");
        await hostForm.locator("button[type='submit'], button:not([type])").click();
        await closed(component);
        expect(await component.locator("[data-host-id='host-1']").textContent()).toContain(
          "192.0.2.11",
        );
        await component.locator("[data-host-id='host-1'] [data-mutation='enable-host']").click();
        await modal.locator("[data-confirm-mutation]").click();
        await closed(component);
        expect(
          await component
            .locator("[data-host-id='host-1'] [data-mutation='disable-host']")
            .isEnabled(),
        ).toBe(true);
        const environmentTrigger = component.locator("[data-edit-environment='host-1']");
        await environmentTrigger.click();
        await fits(modal, viewport);
        await modal.locator(".dialog-heading [data-close-admin]").click();
        await closed(component);
        await expect
          .poll(() =>
            environmentTrigger.evaluate(
              (element) => (element.getRootNode() as ShadowRoot).activeElement === element,
            ),
          )
          .toBe(true);
        await environmentTrigger.click();
        const environment = modal.locator("form[data-action='update-host-execution-environment']");
        await environment.locator("[name='pathPrepend']").fill("/opt/fixture/bin");
        await environment.locator("[name='environmentVariables']").fill("FIXTURE=1");
        await environment.locator("button[type='submit'], button:not([type])").click();
        await modal
          .getByRole("alert")
          .filter({ hasText: "Fixture environment unavailable" })
          .waitFor();
        expect(await environment.locator("[name='pathPrepend']").inputValue()).toBe(
          "/opt/fixture/bin",
        );
        expect(await environment.locator("[name='environmentVariables']").inputValue()).toBe(
          "FIXTURE=1",
        );
        expect(await environment.locator("[name='pathPrepend']").isEnabled()).toBe(true);
        await fits(modal, viewport);
        await screenshot(page, `${name}-02-save-error.png`);
        const editorHeadingTop = await modal
          .locator(".dialog-heading")
          .evaluate((heading) => heading.getBoundingClientRect().top);
        const releaseEnvironment = hold("update-host-execution-environment");
        await environment.locator("button[type='submit'], button:not([type])").click();
        await modal
          .locator("[data-operation-phase='working'] [data-stage='save-environment']")
          .waitFor();
        await workingLayout(modal, viewport, 1);
        const workingHeadingTop = await modal
          .locator(".dialog-heading")
          .evaluate((heading) => heading.getBoundingClientRect().top);
        expect(Math.abs(workingHeadingTop - editorHeadingTop)).toBeLessThan(1);
        await page.keyboard.press("Escape");
        await closed(component);
        expect(await component.locator("[data-add-host]").isDisabled()).toBe(true);
        expect(await component.locator("[data-admin-tab='audit']").isEnabled()).toBe(true);
        await component.locator("[data-view-progress]").click();
        await expect
          .poll(() =>
            modal.locator("dialog").evaluate((dialog) => (dialog as HTMLDialogElement).open),
          )
          .toBe(true);
        expect(
          await modal
            .locator("dialog")
            .evaluate((current, previous) => current === previous, native),
        ).toBe(true);
        await modal.locator("[data-stage='save-environment']").waitFor({ state: "visible" });
        await screenshot(page, `${name}-03-background-progress.png`);
        releaseEnvironment();
        await closed(component);
        await environmentTrigger.click();
        expect(await environment.locator("[name='pathPrepend']").inputValue()).toBe(
          "/opt/fixture/bin",
        );
        expect(await environment.locator("[name='environmentVariables']").inputValue()).toBe(
          "FIXTURE=1",
        );
        await modal.locator(".dialog-heading [data-close-admin]").click();
        await closed(component);
        failRefresh = true;
        await component.locator("[data-refresh]").click();
        await component
          .getByRole("alert")
          .filter({ hasText: "Fixture administration unavailable" })
          .waitFor();
        await component.locator("[data-refresh]").click();
        await expect
          .poll(() =>
            component.getByText("Fixture administration unavailable", { exact: true }).count(),
          )
          .toBe(0);
        expect(mutations.map((request) => request.action)).toEqual([
          "enable-endpoint",
          "update-host",
          "enable-host",
          "update-host-execution-environment",
          "update-host-execution-environment",
        ]);
        expect(mutations.at(-1)?.body).toEqual({
          action: "update-host-execution-environment",
          vmHostId: "host-1",
          executionEnvironment: { pathPrepend: ["/opt/fixture/bin"], variables: { FIXTURE: "1" } },
        });
        expect(pageErrors).toEqual([]);
        await screenshot(page, `${name}-04-saved.png`);
      } finally {
        for (const release of releases) {
          release();
        }
        await context.close();
      }
    },
  );
});
