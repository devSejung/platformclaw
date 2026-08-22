// PlatformClaw Canvas E2E crosses client capability gating, show_widget, Gateway hosting, and BFF relay.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPlatformClawExecutionBackendFactory,
  type PlatformClawExecutionTargetSnapshot,
} from "../../../extensions/platformclaw-execution/api.js";
import { PlatformClawBrowserCanvasRelay } from "../../../packages/platformclaw-control-plane/src/browser-canvas-http.js";
import { filterToolsByPolicy } from "../../../src/agents/agent-tools.policy.js";
import { createOpenClawTools } from "../../../src/agents/openclaw-tools.js";
import { expandToolGroups } from "../../../src/agents/tool-policy-shared.js";
import { resolveCanvasNodeCapability } from "../../../src/canvas/constants.js";
import type { OpenClawConfig } from "../../../src/config/types.openclaw.js";
import type { ResolvedGatewayAuth } from "../../../src/gateway/auth.js";
import { createGatewayHttpServer } from "../../../src/gateway/server-http.js";
import type { GatewayWsClient } from "../../../src/gateway/server/ws-types.js";
import type {
  CreateSandboxBackendParams,
  SandboxBackendHandle,
} from "../../../src/plugin-sdk/sandbox.js";
import { withEnvAsync } from "../../../src/test-utils/env.js";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const proofDir = path.resolve(process.cwd(), ".artifacts/control-ui-e2e/platformclaw-canvas");
const agentId = "assigned-personal";
const sessionKey = `agent:${agentId}:main`;
const gatewayToken = "platformclaw-canvas-e2e-token";
const resolvedAuth: ResolvedGatewayAuth = {
  mode: "token",
  token: gatewayToken,
  allowTailscale: false,
};

let browser: Browser;
let controlUi: ControlUiE2eServer;

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("expected TCP server address"));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function executionHandle(runtimeId: string): SandboxBackendHandle {
  return {
    id: "selected-handle",
    runtimeId,
    runtimeLabel: runtimeId,
    workdir: `/workspaces/${runtimeId}`,
    buildExecSpec: async () => ({ argv: [runtimeId], env: {}, stdinMode: "pipe-closed" }),
    runShellCommand: async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0 }),
  };
}

async function selectExecutionTarget(
  target: "platform_server" | "assigned_vm",
): Promise<SandboxBackendHandle> {
  const targetSnapshot: PlatformClawExecutionTargetSnapshot =
    target === "platform_server"
      ? { kind: target, agentId, revision: 1, targetId: "basic" }
      : {
          kind: target,
          agentId,
          revision: 2,
          targetId: "vm-one",
          allocationId: "allocation-one",
          credentialRevision: 1,
          vmLabel: "Development VM",
          safeConnectLabel: "Corporate access",
          remoteHomeDir: "/users/assigned.personal",
          remoteWorkspaceDir: "/users/assigned.personal/.platformclaw/workspace",
          endpointHost: "safeconnect.invalid",
          endpointPort: 22,
          adDomain: "example",
          adAccount: "assigned.personal",
          targetAddress: "192.0.2.10",
          linuxAccount: "assigned.personal",
          hostKeyAlgorithm: "ssh-ed25519",
          hostKeyPublicKey: "test-key",
          hostKeyFingerprint: "SHA256:test",
        };
  const factory = createPlatformClawExecutionBackendFactory({
    resolveTarget: async () => targetSnapshot,
    createPlatformServerHandle: async () => executionHandle("basic"),
    createAssignedVmHandle: async () => executionHandle("assigned-vm"),
    listTargetSkills: async () =>
      target === "assigned_vm" ? { revision: "assigned-vm:2", files: [] } : undefined,
    createSkillWorkshopTarget: async () => undefined,
    createSkillInstallTarget: async () => undefined,
    createTerminalProcess: async () => {
      throw new Error("terminal is outside this proof");
    },
  });
  return await factory({
    agentId,
    sessionKey,
    scopeKey: `${agentId}:${target}`,
    workspaceDir: `/gateway/${agentId}`,
    agentWorkspaceDir: `/gateway/agents/${agentId}`,
    materializeSkills: async () => undefined,
    cfg: {} as CreateSandboxBackendParams["cfg"],
  });
}

describeControlUiE2e("PlatformClaw browser Canvas delivery", () => {
  beforeAll(async () => {
    await mkdir(proofDir, { recursive: true });
    controlUi = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await controlUi?.close();
  });

  it.each([
    { label: "Basic", target: "platform_server" },
    { label: "Assigned VM", target: "assigned_vm" },
  ] as const)("renders show_widget through the BFF on $label", async ({ label, target }) => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "platformclaw-canvas-e2e-"));
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const selectedExecution = await selectExecutionTarget(target);
      expect(selectedExecution.runtimePromptContext).toContain(
        target === "assigned_vm"
          ? '"activeTarget": "assigned_vm"'
          : '"activeTarget": "platform_server"',
      );
      const config: OpenClawConfig = {
        agents: { entries: { [agentId]: { default: true } } },
        plugins: {
          entries: { canvas: { enabled: false, config: { host: { enabled: true } } } },
        },
        tools: { deny: ["group:nodes"] },
      };
      const tools = filterToolsByPolicy(
        createOpenClawTools({
          agentSessionKey: sessionKey,
          clientCaps: ["inline-widgets"],
          config,
          disableMessageTool: true,
          disablePluginTools: true,
          sandboxed: true,
          sessionId: `${target}-session`,
          wrapBeforeToolCallHook: false,
        }),
        { deny: expandToolGroups(config.tools?.deny) },
      );
      expect(tools.map((tool) => tool.name)).toContain("show_widget");
      for (const unavailable of ["canvas", "nodes", "computer", "mobile_ui"]) {
        expect(
          tools.map((tool) => tool.name),
          unavailable,
        ).not.toContain(unavailable);
      }
      const showWidget = tools.find((tool) => tool.name === "show_widget");
      if (!showWidget?.execute) {
        throw new Error("expected show_widget tool");
      }
      await expect(
        showWidget.execute(`reject-file-url-${target}`, {
          title: `${label} local file`,
          url: "file:///users/assigned.personal/.platformclaw/workspace/widget.html",
        }),
      ).rejects.toThrow("widget_code required");
      const toolResult = await showWidget.execute(`show-widget-${target}`, {
        title: `${label} widget`,
        widget_code: `<main data-proof-target="${target}"><h1>${label}</h1><p>Gateway-owned widget</p></main>`,
      });
      const details = toolResult.details as {
        view?: { url?: string };
      };
      const documentPath = details.view?.url;
      if (!documentPath) {
        throw new Error("show_widget did not return a document URL");
      }

      const gateway = createGatewayHttpServer({
        clients: new Set<GatewayWsClient>(),
        controlUiEnabled: false,
        controlUiBasePath: "/__control__",
        openAiChatCompletionsEnabled: false,
        openResponsesEnabled: false,
        handleHooksRequest: async () => false,
        handlePluginRequest: async () => false,
        resolvePluginNodeCapabilityRoute: (pathContext) =>
          resolveCanvasNodeCapability(pathContext.candidates),
        resolvedAuth,
        getRuntimeConfig: () => config,
      });
      const gatewayOrigin = await listen(gateway);
      let relay: PlatformClawBrowserCanvasRelay | undefined;
      const bff = createServer((req, res) => {
        if (!relay) {
          res.statusCode = 503;
          res.end();
          return;
        }
        void relay.handle(req, res).then((handled) => {
          if (!handled) {
            res.statusCode = 404;
            res.end();
          }
        });
      });
      const bffOrigin = await listen(bff);
      relay = new PlatformClawBrowserCanvasRelay({
        publicOrigin: bffOrigin,
        gatewayOrigin,
        gatewayAuth: gatewayToken,
        gatewayProxy: {
          resolveAccess: async () => ({ binding: { agentId } }),
        },
      });
      const surface = relay.issueSurface({ binding: { agentId } });
      const context = await browser.newContext({ locale: "en-US" });
      try {
        await context.addCookies([
          { name: "platformclaw_session", value: "browser-token", url: bffOrigin },
        ]);
        const page = await context.newPage();
        const gatewayMock = await installMockGateway(page, {
          assistantAgentId: agentId,
          defaultAgentId: agentId,
          featureMethods: ["chat.metadata", "chat.startup"],
          historyMessages: [
            {
              role: "toolResult",
              toolCallId: `show-widget-${target}`,
              toolName: "show_widget",
              content: toolResult.content,
              details: toolResult.details,
              timestamp: 1,
            },
          ],
          pluginSurfaceUrls: surface.pluginSurfaceUrls,
          sessionKey,
        });
        await page.goto(`${controlUi.baseUrl}chat`);
        await expect
          .poll(async () => (await gatewayMock.getRequests("connect")).length)
          .toBeGreaterThan(0);
        const connectParams = (await gatewayMock.getRequests("connect"))[0]?.params as {
          caps?: string[];
        };
        expect(connectParams.caps).toContain("inline-widgets");

        const preview = page.locator('.chat-tool-card__preview[data-kind="canvas"]');
        await preview.waitFor();
        const frame = preview.frameLocator("iframe");
        await expect
          .poll(() => frame.locator(`[data-proof-target="${target}"]`).textContent())
          .toContain(label);
        expect(await preview.locator("iframe").getAttribute("src")).toBe(
          `${surface.pluginSurfaceUrls.canvas}${documentPath}`,
        );
        await page.screenshot({
          path: path.join(proofDir, `${target}.png`),
          fullPage: true,
        });
      } finally {
        await context.close();
        await Promise.all([close(bff), close(gateway)]);
      }
    });
    await rm(stateDir, { recursive: true, force: true });
  });
});
