#!/usr/bin/env node
import { chromium, type Browser } from "playwright";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../ui/src/test-helpers/control-ui-e2e.ts";
import {
  CONTROL_UI_PREVIEW_FIXTURES,
  findControlUiPreviewFixture,
  type ControlUiPreviewOptions,
  type ControlUiPreviewSession,
  type ControlUiPreviewTheme,
  type ControlUiPreviewThemeMode,
} from "../ui/src/test-helpers/control-ui-preview-fixtures.ts";

type PreviewArgs = {
  fixtureId: string | null;
  help: boolean;
  list: boolean;
  locale: string | null;
  mode: ControlUiPreviewThemeMode | null;
  theme: ControlUiPreviewTheme | null;
  viewport: { height: number; width: number } | null;
};

const VIEWPORT_PRESETS: Readonly<Record<string, { height: number; width: number }>> = {
  desktop: { width: 1440, height: 900 },
  fhd: { width: 1920, height: 1080 },
  mobile: { width: 390, height: 844 },
};
const PREVIEW_THEMES = new Set<ControlUiPreviewTheme>(["platformclaw", "claw", "knot", "dash"]);

function printUsage(): void {
  console.log(
    [
      "Usage:",
      "  pnpm ui:fixture-preview -- <fixture> [options]",
      "  pnpm ui:fixture-preview -- --list",
      "",
      "Options:",
      "  --viewport <desktop|fhd|mobile|WIDTHxHEIGHT>",
      "  --mode <light|dark>",
      "  --theme <platformclaw|claw|knot|dash>",
      "  --locale <locale>",
      "  --list",
      "  --help",
      "",
      "Example:",
      "  pnpm ui:fixture-preview -- platformclaw-memory --viewport 1920x1080 --theme knot --mode dark --locale ko-KR",
    ].join("\n"),
  );
}

function parseViewport(value: string): { height: number; width: number } {
  const preset = VIEWPORT_PRESETS[value.toLowerCase()];
  if (preset) {
    return preset;
  }
  const match = /^(\d{2,5})x(\d{2,5})$/u.exec(value);
  if (!match) {
    throw new Error("Invalid viewport: " + value);
  }
  const width = Number.parseInt(match[1]!, 10);
  const height = Number.parseInt(match[2]!, 10);
  if (width < 240 || height < 240 || width > 7680 || height > 7680) {
    throw new Error("Viewport must be between 240 and 7680 pixels per dimension");
  }
  return { width, height };
}

function readValue(argv: string[], index: number, name: string): string {
  const value = argv[index + 1]?.trim();
  if (!value || value.startsWith("--")) {
    throw new Error(name + " requires a value");
  }
  return value;
}

function parseArgs(argv: string[]): PreviewArgs {
  const parsed: PreviewArgs = {
    fixtureId: null,
    help: false,
    list: false,
    locale: null,
    mode: null,
    theme: null,
    viewport: null,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    // Package-script runners may forward their leading argument separator.
    if (index === 0 && arg === "--") {
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--list") {
      parsed.list = true;
      continue;
    }
    if (arg === "--viewport") {
      parsed.viewport = parseViewport(readValue(argv, index, arg));
      index++;
      continue;
    }
    if (arg === "--mode") {
      const mode = readValue(argv, index, arg);
      if (mode !== "light" && mode !== "dark") {
        throw new Error("--mode must be light or dark");
      }
      parsed.mode = mode;
      index++;
      continue;
    }
    if (arg === "--theme") {
      const theme = readValue(argv, index, arg);
      if (!PREVIEW_THEMES.has(theme as ControlUiPreviewTheme)) {
        throw new Error("--theme must be platformclaw, claw, knot, or dash");
      }
      parsed.theme = theme as ControlUiPreviewTheme;
      index++;
      continue;
    }
    if (arg === "--locale") {
      parsed.locale = readValue(argv, index, arg);
      index++;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error("Unknown option: " + arg);
    }
    if (parsed.fixtureId) {
      throw new Error("Only one fixture can be selected");
    }
    parsed.fixtureId = arg;
  }
  return parsed;
}

function printFixtures(): void {
  const columnWidth =
    Math.max(...CONTROL_UI_PREVIEW_FIXTURES.map((fixture) => fixture.id.length)) + 2;
  for (const fixture of CONTROL_UI_PREVIEW_FIXTURES) {
    console.log(fixture.id.padEnd(columnWidth) + fixture.label + " - " + fixture.description);
  }
}

function waitForStop(browser: Browser): Promise<void> {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = () => {
      if (resolved) {
        return;
      }
      resolved = true;
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
      resolve();
    };
    browser.once("disconnected", finish);
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }
  if (args.list) {
    printFixtures();
    return;
  }
  if (!args.fixtureId) {
    printUsage();
    throw new Error("Choose a fixture or pass --list");
  }
  const fixture = findControlUiPreviewFixture(args.fixtureId);
  if (!fixture) {
    printFixtures();
    throw new Error("Unknown fixture: " + args.fixtureId);
  }

  const options: ControlUiPreviewOptions = {
    locale: args.locale ?? fixture.defaults.locale,
    mode: args.mode ?? fixture.defaults.mode,
    theme: args.theme ?? fixture.defaults.theme,
    viewport: args.viewport ?? fixture.defaults.viewport,
  };
  const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
  if (!canRunPlaywrightChromium(executablePath)) {
    throw new Error(
      "Playwright Chromium is unavailable at " +
        executablePath +
        ". Run pnpm --dir ui exec playwright install chromium first.",
    );
  }

  let browser: Browser | null = null;
  let server: ControlUiE2eServer | null = null;
  let session: ControlUiPreviewSession | null = null;
  try {
    server = await startControlUiE2eServer(undefined, { source: true });
    browser = await chromium.launch({
      executablePath,
      headless: false,
      args: [
        "--window-size=" +
          String(options.viewport.width + 40) +
          "," +
          String(options.viewport.height + 120),
      ],
    });
    session = await fixture.open({ browser, server, options });
    const renderedViewport = await session.page.evaluate(() => ({
      height: window.innerHeight,
      width: window.innerWidth,
    }));

    console.log("");
    console.log("Control UI fixture preview");
    console.log("  fixture   " + fixture.id + " (" + fixture.label + ")");
    console.log("  url       " + session.page.url());
    console.log(
      "  viewport  " + String(renderedViewport.width) + "x" + String(renderedViewport.height),
    );
    console.log("  mode      " + options.mode);
    console.log("  theme     " + options.theme);
    console.log("  locale    " + options.locale);
    console.log("");
    console.log("Close the preview browser or press Ctrl-C to stop.");
    await waitForStop(browser);
  } finally {
    await session?.context.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
