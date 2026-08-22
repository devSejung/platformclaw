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

async function screenshot(page: Page): Promise<void> {
  if (!captureProof) {
    return;
  }
  await mkdir(proofDir, { recursive: true });
  await page.screenshot({ animations: "disabled", path: path.join(proofDir, "01-overview.png") });
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

  it("shows disabled SafeConnect and VM recovery controls", async () => {
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
    await page.close();
  });
});
