import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(executablePath);
const allowMissing = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeE2e = chromiumAvailable || !allowMissing ? describe : describe.skip;
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "platformclaw-vm-admin");

let browser: Browser;
let server: ControlUiE2eServer;

async function screenshot(page: Page, name = "01-overview.png"): Promise<void> {
  if (!captureProof) {
    return;
  }
  await mkdir(proofDir, { recursive: true });
  await page.screenshot({ animations: "disabled", path: path.join(proofDir, name) });
}

describeE2e("PlatformClaw VM administration", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Chromium unavailable at ${executablePath}`);
    }
    server = await startControlUiE2eServer(undefined, { source: true });
    browser = await chromium.launch({ executablePath });
  });
  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("shows disabled SafeConnect and VM recovery controls on PC", async () => {
    const page = await browser.newPage({ locale: "en-US", viewport: { width: 1360, height: 900 } });
    await page.route("**/platformclaw/api/admin/vm", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
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
          ],
          hosts: [
            {
              id: "host-1",
              endpointId: "endpoint-1",
              label: "Development VM",
              targetAddress: "192.0.2.10",
              status: "disabled",
            },
          ],
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
        }),
      });
    });
    await page.goto(new URL("sw.js", server.baseUrl).href);
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({
      type: "module",
      url: `${server.baseUrl}src/platformclaw/vm-administration.ts`,
    });
    await page.evaluate(async () => {
      await customElements.whenDefined("platformclaw-vm-administration");
      document.body.replaceChildren(document.createElement("platformclaw-vm-administration"));
    });
    const component = page.locator("platformclaw-vm-administration");
    const initialRefresh = page.waitForResponse("**/platformclaw/api/admin/vm");
    await component.locator("[data-open]").evaluate((button: HTMLElement) => button.click());
    await initialRefresh;
    await expect
      .poll(async () =>
        component.locator("strong").filter({ hasText: "Corporate access" }).isVisible(),
      )
      .toBe(true);
    await expect
      .poll(async () =>
        component.locator("strong").filter({ hasText: "Development VM" }).isVisible(),
      )
      .toBe(true);
    await expect
      .poll(async () => component.getByRole("button", { name: "Enable endpoint" }).isVisible())
      .toBe(true);
    await expect
      .poll(async () => component.getByText("Edit and verify again").isVisible())
      .toBe(true);
    await expect
      .poll(async () => component.getByRole("button", { name: "Enable VM" }).isVisible())
      .toBe(true);
    await expect
      .poll(async () => component.getByRole("button", { name: "Enable VM" }).isDisabled())
      .toBe(true);
    await expect
      .poll(async () =>
        component.getByText("Enable this VM's SafeConnect endpoint before editing it.").isVisible(),
      )
      .toBe(true);
    await screenshot(page);
    const snapshot = await page.evaluate(async () =>
      (await fetch("/platformclaw/api/admin/vm")).json(),
    );
    let failNext = false;
    let hold: Promise<void> | undefined;
    const mutations: string[] = [];
    await page.route("**/platformclaw/api/admin/vm", async (route) => {
      if (hold) {
        await hold;
        hold = undefined;
      }
      if (failNext) {
        failNext = false;
        await route.fulfill({ status: 503, json: { error: "Fixture administration unavailable" } });
        return;
      }
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON();
        mutations.push(body.action);
        if (body.action === "enable-endpoint") {
          snapshot.endpoints[0].status = "active";
        }
        if (body.action === "disable-endpoint") {
          snapshot.endpoints[0].status = "disabled";
        }
        if (body.action === "enable-host") {
          snapshot.hosts[0].status = "active";
        }
        if (body.action === "disable-host") {
          snapshot.hosts[0].status = "disabled";
        }
      }
      await route.fulfill({ json: snapshot });
    });
    await component.getByRole("button", { name: "Enable endpoint", exact: true }).click();
    await component.locator("[data-cancel-mutation]").click();
    expect(mutations).toEqual([]);
    await component.getByRole("button", { name: "Enable endpoint", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect.poll(() => component.getByRole("dialog").count()).toBe(0);
    await component.locator("[data-open]").click();
    await expect.poll(() => component.locator("[data-refresh]").isEnabled()).toBe(true);
    expect(await component.locator("[data-confirm-mutation]").count()).toBe(0);
    await component.getByRole("button", { name: "Enable endpoint", exact: true }).click();
    let release!: () => void;
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    await component.locator("[data-confirm-mutation]").click();
    expect(await component.locator("[data-refresh]").isDisabled()).toBe(true);
    expect(await component.locator("main button:enabled").count()).toBe(0);
    expect(await component.locator("[data-close]").isEnabled()).toBe(true);
    release();
    await expect
      .poll(() =>
        component.getByRole("button", { name: "Disable endpoint", exact: true }).isEnabled(),
      )
      .toBe(true);
    await component.getByRole("button", { name: "Enable VM", exact: true }).click();
    await component.locator("[data-confirm-mutation]").click();
    await expect
      .poll(() => component.getByRole("button", { name: "Disable VM", exact: true }).isEnabled())
      .toBe(true);
    await component.getByText("Build environment", { exact: true }).click();
    const environmentForm = component.locator(
      "form[data-action='update-host-execution-environment']",
    );
    await environmentForm.locator("textarea[name='pathPrepend']").fill("/opt/fixture/bin");
    await environmentForm.locator("textarea[name='environmentVariables']").fill("FIXTURE=1");
    await environmentForm.locator("button").click();
    await expect.poll(() => mutations.at(-1)).toBe("update-host-execution-environment");
    await expect.poll(() => component.locator("[data-refresh]").isEnabled()).toBe(true);
    failNext = true;
    await component.locator("[data-refresh]").click();
    await component.getByText("Fixture administration unavailable", { exact: true }).waitFor();
    await component.locator("[data-refresh]").click();
    await expect
      .poll(() =>
        component.getByText("Fixture administration unavailable", { exact: true }).count(),
      )
      .toBe(0);
    expect(mutations).toEqual([
      "enable-endpoint",
      "enable-host",
      "update-host-execution-environment",
    ]);
    await screenshot(page, "PC-controls-final.png");
    await page.close();
  });
});
