import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright";
import { PLATFORMCLAW_WEB_GATEWAY_METHODS } from "../../../packages/platformclaw-control-plane/src/browser-gateway-policy.ts";
import {
  createPlatformClawWebAssetHandler,
  PLATFORMCLAW_WEB_APP_PATH,
  PLATFORMCLAW_WEB_TERMINAL_ENABLED,
} from "../../../packages/platformclaw-control-plane/src/web-assets.ts";
import {
  buildProductionControlUiE2e,
  installMockGateway,
  type ControlUiE2eServer,
  type ControlUiMockGatewayScenario,
} from "./control-ui-e2e.ts";

/** Serve the shipped employee document and its real response headers, without CSP substitution. */
export async function startPlatformClawControlUiE2eServer(
  buildId: string,
): Promise<ControlUiE2eServer> {
  const buildDirectory = await mkdtemp(path.join(tmpdir(), "platformclaw-employee-e2e-"));
  let assets: ReturnType<typeof createPlatformClawWebAssetHandler>;
  const server = createServer((req, res) => {
    void (async () => {
      if (!(await assets.handlePublic(req, res)) && !(await assets.handleApplication(req, res))) {
        res.writeHead(404).end();
      }
    })().catch(() => {
      if (res.headersSent) {
        res.destroy();
      } else {
        res.writeHead(500).end();
      }
    });
  });
  const close = async () => {
    try {
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    } finally {
      await rm(buildDirectory, { recursive: true, force: true });
    }
  };
  try {
    await buildProductionControlUiE2e(buildDirectory, buildId);
    const [{ build }, { default: loginConfig }] = await Promise.all([
      import("vite"),
      import("../../vite.platformclaw-login.config.ts"),
    ]);
    await build({
      ...loginConfig({ outDir: buildDirectory }),
      configFile: false,
      logLevel: "error",
      root: fileURLToPath(new URL("../..", import.meta.url)),
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Employee web server did not expose a TCP port");
    }
    const origin = `http://127.0.0.1:${address.port}`;
    assets = createPlatformClawWebAssetHandler(buildDirectory, { publicOrigin: origin });
    return { baseUrl: `${origin}${PLATFORMCLAW_WEB_APP_PATH}/`, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Mock employee identity and Gateway data while retaining the real employee asset owner. */
export async function installPlatformClawMockGateway(
  page: Page,
  scenario: ControlUiMockGatewayScenario = {},
) {
  await page.route("**/platformclaw/api/auth/session", (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        user: {
          accountId: "preview.one",
          displayName: "Preview One",
          department: "Platform Lab",
          globalRole: "member",
        },
        agent: { agentId: scenario.defaultAgentId?.trim() || "main", state: "active" },
        session: { idleExpiresAt: Date.now() + 60_000, absoluteExpiresAt: Date.now() + 120_000 },
      },
    }),
  );
  await page.addInitScript(() => {
    localStorage.setItem("platformclaw.product-tour.v1.completed", "true");
  });
  return installMockGateway(page, {
    basePath: PLATFORMCLAW_WEB_APP_PATH,
    featureMethods: [...PLATFORMCLAW_WEB_GATEWAY_METHODS],
    terminalEnabled: PLATFORMCLAW_WEB_TERMINAL_ENABLED,
    ...scenario,
  });
}

/** Record bounded renderer CSP facts without retaining source URLs or attachment tickets. */
export async function observePlatformClawPreviewCsp(page: Page): Promise<readonly string[]> {
  const violations: string[] = [];
  page.on("console", (message) => {
    const prefix = "document-preview-csp ";
    if (message.text().startsWith(prefix) && violations.length < 8) {
      const diagnostic = message.text().slice(prefix.length, prefix.length + 200);
      violations.push(diagnostic);
      console.log(prefix + diagnostic);
    }
  });
  await page.addInitScript(() => {
    let reported = 0;
    document.addEventListener("securitypolicyviolation", (event) => {
      if (reported++ < 8) {
        console.log(
          "document-preview-csp",
          JSON.stringify({
            directive: event.effectiveDirective,
            blockedScheme: event.blockedURI.split(":", 1)[0]?.slice(0, 16),
            disposition: event.disposition,
          }),
        );
      }
    });
  });
  return violations;
}
