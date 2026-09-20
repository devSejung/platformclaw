import type { Browser, BrowserContext, Page } from "playwright";
import type { ThemeName } from "../app/theme.ts";
import {
  installMockGateway,
  waitForControlUiRoute,
  type ControlUiE2eServer,
} from "./control-ui-e2e.ts";
import {
  createPlatformClawMemoryContext,
  installPlatformClawMemoryDocument,
  platformClawMemoryAgentId,
  platformClawMemoryMethods,
  platformClawMemoryResponses,
} from "./platformclaw-memory-fixture.ts";

export type ControlUiPreviewThemeMode = "dark" | "light";
export type ControlUiPreviewTheme = Exclude<ThemeName, "custom">;

export type ControlUiPreviewOptions = {
  locale: string;
  mode: ControlUiPreviewThemeMode;
  theme: ControlUiPreviewTheme;
  viewport: { height: number; width: number };
};

export type ControlUiPreviewSession = {
  context: BrowserContext;
  page: Page;
};

export type ControlUiPreviewFixture = {
  id: string;
  label: string;
  description: string;
  defaults: ControlUiPreviewOptions;
  open: (params: {
    browser: Browser;
    server: ControlUiE2eServer;
    options: ControlUiPreviewOptions;
  }) => Promise<ControlUiPreviewSession>;
};

const platformClawMemoryFixture: ControlUiPreviewFixture = {
  id: "platformclaw-memory",
  label: "PlatformClaw Memory",
  description:
    "Populated personal Memory, Personal Wiki, organization sharing, and Dreaming with synthetic data.",
  defaults: {
    locale: "ko-KR",
    mode: "light",
    theme: "platformclaw",
    viewport: { width: 1440, height: 900 },
  },
  async open({ browser, server, options }) {
    const context = await createPlatformClawMemoryContext(browser, server.baseUrl, options);
    const page = await context.newPage();
    await installPlatformClawMemoryDocument(page, server.baseUrl);
    await installMockGateway(page, {
      basePath: "/platformclaw/app",
      defaultAgentId: platformClawMemoryAgentId,
      featureMethods: [...platformClawMemoryMethods],
      methodResponses: platformClawMemoryResponses,
    });
    const pathname = "/platformclaw/app/settings/memory";
    const response = await page.goto(server.baseUrl + pathname.slice(1));
    if (response?.status() !== 200) {
      throw new Error("Fixture page failed to load: HTTP " + String(response?.status()));
    }
    await waitForControlUiRoute(page, { routeId: "memory", pathname });
    await page.waitForFunction(() => {
      const surface = document.querySelector("openclaw-memory-memories");
      return surface?.textContent?.includes("MEMORY.md") === true;
    });
    return { context, page };
  },
};

export const CONTROL_UI_PREVIEW_FIXTURES: readonly ControlUiPreviewFixture[] = [
  platformClawMemoryFixture,
];

export function findControlUiPreviewFixture(id: string): ControlUiPreviewFixture | null {
  return CONTROL_UI_PREVIEW_FIXTURES.find((fixture) => fixture.id === id) ?? null;
}
