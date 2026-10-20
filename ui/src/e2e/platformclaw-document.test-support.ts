import type { Page } from "playwright";
import { PLATFORMCLAW_WEB_DESCRIPTOR } from "../platformclaw/web-contract.ts";

export async function installPlatformClawDocument(page: Page, baseUrl: string): Promise<void> {
  const response = await page.request.get(baseUrl);
  const source = await response.text();
  await page.route("**/platformclaw/app/**", (route) =>
    route.fulfill({
      status: response.status(),
      headers: response.headers(),
      body: source.replace(
        "</head>",
        `<meta name="platformclaw-web-descriptor" content='${JSON.stringify(PLATFORMCLAW_WEB_DESCRIPTOR)}'></head>`,
      ),
    }),
  );
}

export async function settlePlatformClawRendering(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}
