import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Locator } from "playwright";
import { expect, it, vi } from "vitest";
import type { SessionsFilesDownloadResult } from "../../../packages/gateway-protocol/src/index.js";
import { setupBrowserGatewayProxyTest } from "../../../packages/platformclaw-control-plane/src/browser-gateway-proxy.test-harness.js";
import { sessionsFilesDownloadHandlers } from "../../../src/gateway/server-methods/sessions-files-download.js";
import type {
  GatewayRequestContext,
  RespondFn,
} from "../../../src/gateway/server-methods/types.js";
import { installFullGatewayMock as installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const fixture = vi.hoisted(() => ({ loadRoot: vi.fn() }));
// Only session discovery and the browser wire are synthetic; Gateway bytes and BFF policy are real.
vi.mock("../../../src/gateway/server-methods/sessions-file-root.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../src/gateway/server-methods/sessions-file-root.js")
  >("../../../src/gateway/server-methods/sessions-file-root.js");
  return { ...actual, loadSessionFileRoot: fixture.loadRoot };
});

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "workspace-download");
const method = "sessions.files.download";
const maxDownloadBytes = 16 * 1024 * 1024;
const suite = createControlUiE2eSuite({
  name: "Basic workspace bounded file download",
  trackBrowserContexts: true,
  unavailableMessage: (executablePath) => `Chromium is unavailable at ${executablePath}`,
});

suite.define(() => {
  it("saves binary, empty, and 16 MiB files and shows the oversized error through the real Gateway and BFF", async () => {
    const tempRoot = await realpath(os.tmpdir());
    const root = await mkdtemp(path.join(tempRoot, "platformclaw-workspace-download-"));
    const workspace = path.join(root, "workspace");
    const downloadsDir = captureUiProof
      ? path.join(proofDir, "downloads")
      : path.join(root, "saved");
    await mkdir(path.join(workspace, "docs"), { recursive: true });
    await mkdir(downloadsDir, { recursive: true });
    const binaryName = "합성 binary file.bin";
    const binaryPath = `docs/${binaryName}`;
    const emptyName = "빈 파일.txt";
    const limitName = "limit-16MiB.bin";
    const oversizedName = "too-large.bin";
    const binary = Buffer.alloc(256 * 1024 + 17, 0xa5);
    binary.set([0, 255, 128, 13, 10], binary.length - 5);
    const limit = Buffer.alloc(maxDownloadBytes, 0xab);
    await writeFile(path.join(workspace, binaryPath), binary);
    await writeFile(path.join(workspace, emptyName), Buffer.alloc(0));
    await writeFile(path.join(workspace, limitName), limit);
    await writeFile(path.join(workspace, oversizedName), Buffer.alloc(maxDownloadBytes + 1));
    const authFixture = await setupBrowserGatewayProxyTest();
    const agentId = authFixture.binding.agentId;
    const sessionKey = `agent:${agentId}:main`;
    fixture.loadRoot.mockReturnValue({
      root: workspace,
      agentId,
      canonicalKey: sessionKey,
      entry: { sessionId: "synthetic-workspace-download" },
    });
    authFixture.request.mockImplementation(async (requestMethod, params) => {
      expect(requestMethod).toBe(method);
      const responses: Array<{
        ok: boolean;
        payload?: unknown;
        error?: { code: string; message: string; details?: unknown };
      }> = [];
      const respond: RespondFn = (ok, payload, error) => {
        responses.push({ ok, payload, error });
      };
      // This fixture terminates the response in memory; production waits for socket completion.
      respond.withCompletion = async (...args) => respond(...args);
      const handler = sessionsFilesDownloadHandlers[method];
      if (!handler || !params || typeof params !== "object" || Array.isArray(params)) {
        throw new Error("Expected a workspace download request");
      }
      await handler({
        req: { type: "req", id: `synthetic-${responses.length}`, method },
        params: params as Record<string, unknown>,
        context: {} as GatewayRequestContext,
        client: null,
        respond,
        isWebchatConnect: () => false,
      });
      expect(responses).toHaveLength(1);
      const response = responses[0]!;
      if (!response.ok) {
        throw Object.assign(
          new Error(response.error?.message ?? "Workspace download failed"),
          response.error,
        );
      }
      return response.payload;
    });
    const context = await suite.newBrowserContext({
      serviceWorkers: "block",
      locale: "en-US",
      viewport: { width: 1440, height: 900 },
      ...(captureUiProof
        ? { recordVideo: { dir: proofDir, size: { width: 1440, height: 900 } } }
        : {}),
    });
    const page = await context.newPage();
    let downloadCount = 0;
    page.on("download", () => {
      downloadCount += 1;
    });
    const captures: string[] = [];
    const savedFiles: Array<{
      source: string;
      name: string;
      bytes: number;
      sha256: string;
      savedPath?: string;
    }> = [];
    const gateway = await installMockGateway(page, {
      sessionKey,
      defaultAgentId: agentId,
      methodResponses: {
        "sessions.files.list": {
          sessionKey,
          downloadAllowed: true,
          files: [
            {
              kind: "modified",
              name: binaryName,
              path: "transcript-cwd/report.bin",
              workspacePath: binaryPath,
              size: binary.length,
              missing: false,
            },
            {
              kind: "read",
              name: emptyName,
              path: "transcript-cwd/empty.txt",
              workspacePath: emptyName,
              size: 0,
              missing: false,
            },
          ],
          browser: {
            path: "",
            entries: [
              { kind: "directory", name: "docs", path: "docs" },
              { kind: "file", name: limitName, path: limitName, size: limit.length },
              {
                kind: "file",
                name: oversizedName,
                path: oversizedName,
                size: maxDownloadBytes + 1,
              },
            ],
          },
        },
      },
    });
    async function capture(name: string) {
      expect(await page.locator("body").textContent()).not.toContain(workspace);
      if (captureUiProof) {
        const destination = path.join(proofDir, `${name}.png`);
        await page.screenshot({ path: destination, animations: "disabled", fullPage: true });
        captures.push(destination);
      }
    }
    async function serveDownload(count: number, relativePath: string) {
      await expect.poll(async () => (await gateway.getRequests(method)).length).toBe(count);
      const request = (await gateway.getRequests(method)).at(-1);
      expect(request?.params).toEqual({ sessionKey, agentId, path: relativePath });
      try {
        const result = await authFixture.proxy.request<SessionsFilesDownloadResult>(
          authFixture.token,
          method,
          request!.params,
        );
        await gateway.resolveDeferred(method, result);
        return { ok: true as const, result };
      } catch (error) {
        const rejected = error as { code?: string; message?: string; details?: unknown };
        const responseError = {
          code: rejected.code ?? "UNAVAILABLE",
          message: rejected.message ?? "Workspace download failed",
          details: rejected.details,
        };
        await gateway.rejectDeferred(method, responseError);
        return { ok: false as const, error: responseError };
      }
    }
    async function saveDownload(
      button: Locator,
      source: string,
      name: string,
      relativePath: string,
      bytes: Buffer,
      count: number,
    ) {
      await gateway.deferNext(method);
      await button.click();
      const downloaded = page.waitForEvent("download");
      expect((await serveDownload(count, relativePath)).ok).toBe(true);
      const download = await downloaded;
      expect(download.suggestedFilename()).toBe(name);
      const destination = path.join(downloadsDir, `${source}-${name}`);
      await download.saveAs(destination);
      expect(await download.failure()).toBeNull();
      const saved = await readFile(destination);
      const sha256 = createHash("sha256").update(saved).digest("hex");
      expect(saved.length).toBe(bytes.length);
      expect(sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
      savedFiles.push({
        source,
        name,
        bytes: saved.length,
        sha256,
        ...(captureUiProof ? { savedPath: destination } : {}),
      });
    }

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.locator(".chat-workspace-toggle").click();
      const sessionRows = page.locator(
        ".chat-workspace-rail__list:not(.chat-workspace-rail__list--browser) .chat-workspace-rail__file",
      );
      const browserRows = page.locator(
        ".chat-workspace-rail__list--browser .chat-workspace-rail__file",
      );
      const directory = page.locator(".chat-workspace-rail__file--directory", { hasText: "docs" });
      await directory.waitFor();
      expect(
        await directory.getByRole("button", { name: "Download file", exact: true }).count(),
      ).toBe(0);
      await capture("ready");
      await saveDownload(
        sessionRows
          .filter({ hasText: "transcript-cwd/report.bin" })
          .getByRole("button", { name: "Download file", exact: true }),
        "changed",
        binaryName,
        binaryPath,
        binary,
        1,
      );
      await saveDownload(
        sessionRows
          .filter({ hasText: "transcript-cwd/empty.txt" })
          .getByRole("button", { name: "Download file", exact: true }),
        "read",
        emptyName,
        emptyName,
        Buffer.alloc(0),
        2,
      );
      await saveDownload(
        browserRows
          .filter({ hasText: limitName })
          .getByRole("button", { name: "Download file", exact: true }),
        "browser",
        limitName,
        limitName,
        limit,
        3,
      );
      await capture("downloaded");
      await gateway.deferNext(method);
      await browserRows
        .filter({ hasText: oversizedName })
        .getByRole("button", { name: "Download file", exact: true })
        .click();
      const rejected = await serveDownload(4, oversizedName);
      expect(rejected).toMatchObject({
        ok: false,
        error: {
          details: { type: "session_file_too_large", maxDownloadBytes, path: oversizedName },
        },
      });
      await page
        .getByText(`File exceeds the 16 MiB workspace download limit: ${oversizedName}`, {
          exact: true,
        })
        .waitFor();
      expect(downloadCount).toBe(3);
      expect(await browserRows.filter({ hasText: limitName }).count()).toBe(1);
      await capture("size-error");
      await page.setViewportSize({ width: 760, height: 900 });
      await expect
        .poll(() => page.locator(".chat-workbench").getAttribute("class"))
        .toContain("chat-workbench--dock-bottom");
      await capture("size-error-narrow");
      await saveDownload(
        sessionRows
          .filter({ hasText: "transcript-cwd/empty.txt" })
          .getByRole("button", { name: "Download file", exact: true }),
        "retry",
        emptyName,
        emptyName,
        Buffer.alloc(0),
        5,
      );
      expect(downloadCount).toBe(4);
      expect(await page.getByRole("alert").count()).toBe(0);
      expect(
        authFixture.request.mock.calls.map(([calledMethod, params]) => ({
          method: calledMethod,
          params,
        })),
      ).toEqual(
        [binaryPath, emptyName, limitName, oversizedName, emptyName].map((selectedPath) => ({
          method,
          params: { sessionKey, agentId, path: selectedPath },
        })),
      );
      expect(await gateway.getRequests("sessions.files.get")).toHaveLength(0);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      process.stdout.write(
        `${JSON.stringify({ proof: "workspace-bounded-rpc-download", gatewayHandler: true, bffPolicy: true, syntheticSessionAndBrowserWire: true, maxDownloadBytes, oversizedRejected: true, downloads: savedFiles, screenshots: captures, ...(captureUiProof ? { video: path.join(proofDir, "workspace-download.webm") } : {}) })}\n`,
      );
    } finally {
      const video = page.video();
      await suite.closeBrowserContext(context);
      if (captureUiProof && video) {
        await video.saveAs(path.join(proofDir, "workspace-download.webm"));
      }
      fixture.loadRoot.mockReset();
      expect(path.dirname(root)).toBe(tempRoot);
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  it.each(["platform_server", "assigned_vm"] as const)(
    "shows download only for a supported execution target: %s",
    async (activeTarget) => {
      const f = await setupBrowserGatewayProxyTest();
      const sessionKey = `agent:${f.binding.agentId}:main`;
      vi.spyOn(f.store, "getPersonalExecutionProfile").mockResolvedValue({
        agentBindingId: f.binding.id,
        activeTarget,
        ...(activeTarget === "assigned_vm" ? { activeAllocationId: "synthetic-allocation" } : {}),
        targetRevision: 1,
        updatedAt: 1_000_000,
      });
      f.request.mockResolvedValue({
        sessionKey,
        uploadAllowed: true,
        files: [],
        browser: {
          path: "",
          entries: [{ kind: "file", name: "synthetic-target.txt", path: "synthetic-target.txt" }],
        },
      });
      const projectedList = await f.proxy.request(f.token, "sessions.files.list", { sessionKey });
      const context = await suite.newBrowserContext({
        serviceWorkers: "block",
        locale: "en-US",
        viewport: { width: 1440, height: 900 },
      });
      const page = await context.newPage();
      const gateway = await installMockGateway(page, {
        sessionKey,
        defaultAgentId: f.binding.agentId,
        methodResponses: { "sessions.files.list": projectedList },
      });
      try {
        await page.goto(`${suite.server.baseUrl}chat`);
        await page.locator(".chat-workspace-toggle").click();
        const row = page.locator(".chat-workspace-rail__file", { hasText: "synthetic-target.txt" });
        await row.waitFor();
        expect(await row.getByRole("button", { name: "Download file", exact: true }).count()).toBe(
          activeTarget === "platform_server" ? 1 : 0,
        );
        expect(await gateway.getRequests(method)).toHaveLength(0);
        if (captureUiProof) {
          await mkdir(proofDir, { recursive: true });
          await page.screenshot({
            path: path.join(proofDir, `target-${activeTarget}.png`),
            animations: "disabled",
            fullPage: true,
          });
        }
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
    60_000,
  );
});
