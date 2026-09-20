import type { Browser, BrowserContext, Page } from "playwright";
import type { ThemeName } from "../app/theme.ts";
import {
  installMockGateway,
  waitForControlUiRoute,
  type ControlUiE2eServer,
} from "./control-ui-e2e.ts";
import {
  platformClawMemoryBusyResponses,
  platformClawMemoryEmptyResponses,
  platformClawMemoryErrorResponses,
} from "./platformclaw-memory-fixture-variants.ts";
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

type ControlUiPreviewFixture = {
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

const platformClawMemoryDefaults: ControlUiPreviewOptions = {
  locale: "ko-KR",
  mode: "light",
  theme: "platformclaw",
  viewport: { width: 1440, height: 900 },
};

function createPlatformClawMemoryFixture(params: {
  id: string;
  label: string;
  description: string;
  responses: typeof platformClawMemoryResponses;
  waitForMemoryFile?: boolean;
}): ControlUiPreviewFixture {
  return {
    id: params.id,
    label: params.label,
    description: params.description,
    defaults: platformClawMemoryDefaults,
    async open({ browser, server, options }) {
      const context = await createPlatformClawMemoryContext(browser, server.baseUrl, options);
      const page = await context.newPage();
      await installPlatformClawMemoryDocument(page, server.baseUrl);
      await installMockGateway(page, {
        basePath: "/platformclaw/app",
        defaultAgentId: platformClawMemoryAgentId,
        featureMethods: [...platformClawMemoryMethods],
        methodResponses: params.responses,
      });
      const pathname = "/platformclaw/app/settings/memory";
      const response = await page.goto(server.baseUrl + pathname.slice(1));
      if (response?.status() !== 200) {
        throw new Error("Fixture page failed to load: HTTP " + String(response?.status()));
      }
      await waitForControlUiRoute(page, { routeId: "memory", pathname });
      await page.waitForFunction((waitForMemoryFile) => {
        const surface = document.querySelector("openclaw-memory-memories");
        return (
          surface !== null &&
          (!waitForMemoryFile || (surface.textContent ?? "").includes("MEMORY.md"))
        );
      }, params.waitForMemoryFile !== false);
      return { context, page };
    },
  };
}

const platformClawMemoryFixture = createPlatformClawMemoryFixture({
  id: "platformclaw-memory",
  label: "PlatformClaw Memory",
  description:
    "Populated personal Memory, Personal Wiki, organization sharing, and Dreaming with synthetic data.",
  responses: platformClawMemoryResponses,
});

const platformClawMemoryBusyFixture = createPlatformClawMemoryFixture({
  id: "platformclaw-memory-busy",
  label: "PlatformClaw Memory · Busy",
  description:
    "Dense synthetic Personal Wiki data for graph navigation, long titles, filters, questions, and contradictions.",
  responses: platformClawMemoryBusyResponses,
});

const platformClawMemoryEmptyFixture = createPlatformClawMemoryFixture({
  id: "platformclaw-memory-empty",
  label: "PlatformClaw Memory · Empty",
  description: "Synthetic empty-state Memory, Personal Wiki, and Dreaming surfaces.",
  responses: platformClawMemoryEmptyResponses,
  waitForMemoryFile: false,
});

export const CONTROL_UI_PREVIEW_FIXTURES: readonly ControlUiPreviewFixture[] = [
  platformClawMemoryFixture,
  platformClawMemoryBusyFixture,
  platformClawMemoryEmptyFixture,
  createPlatformClawMemoryFixture({
    id: "platformclaw-memory-error",
    label: "PlatformClaw Memory · Errors",
    description: "Synthetic unavailable services for local error and retry inspection.",
    responses: platformClawMemoryErrorResponses,
    waitForMemoryFile: false,
  }),
];

export function findControlUiPreviewFixture(id: string): ControlUiPreviewFixture | null {
  return CONTROL_UI_PREVIEW_FIXTURES.find((fixture) => fixture.id === id) ?? null;
}
