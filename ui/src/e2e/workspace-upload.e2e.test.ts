import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { sessionsFilesUploadHandlers } from "../../../src/gateway/server-methods/sessions-files-upload.js";
import type {
  GatewayRequestContext,
  RespondFn,
} from "../../../src/gateway/server-methods/types.js";
import { installFullGatewayMock as installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const fixture = vi.hoisted(() => ({ loadRoot: vi.fn() }));
// Only session discovery is synthetic; selected file bytes go through the real upload handler and filesystem.
vi.mock("../../../src/gateway/server-methods/sessions-file-root.js", () => ({
  loadSessionFileRoot: fixture.loadRoot,
}));

const suite = createControlUiE2eSuite({
  name: "Workspace browser file upload",
  trackBrowserContexts: true,
  unavailableMessage: (executablePath) => `Chromium is unavailable at ${executablePath}`,
});

suite.define(() => {
  it("saves picked binary files, preserves duplicates, and recovers from size and transient errors", async () => {
    const tempRoot = await realpath(os.tmpdir());
    const root = await mkdtemp(path.join(tempRoot, "platformclaw-upload-workspace-"));
    const screenshots = await mkdtemp(path.join(tempRoot, "platformclaw-upload-screenshots-"));
    await mkdir(path.join(root, "docs"));
    await writeFile(path.join(root, "docs", "existing.txt"), "original synthetic file");
    fixture.loadRoot.mockReturnValue({ root, entry: { sessionId: "synthetic-session" } });
    const context = await suite.newBrowserContext({
      serviceWorkers: "block",
      locale: "en-US",
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    const sessionKey = "agent:main:main";

    async function listing(folder: string) {
      const entries = await readdir(path.join(root, folder), { withFileTypes: true });
      return {
        sessionKey,
        // Match the employee BFF projection: the browser never receives the host filesystem root.
        files: [],
        uploadAllowed: true,
        browser: {
          path: folder,
          ...(folder ? { parentPath: "" } : {}),
          entries: entries.map((entry) => ({
            kind: entry.isDirectory() ? "directory" : "file",
            name: entry.name,
            path: folder ? `${folder}/${entry.name}` : entry.name,
          })),
        },
      };
    }
    const gateway = await installMockGateway(page, {
      sessionKey,
      methodResponses: { "sessions.files.list": await listing("") },
    });
    async function updateListing(folder: string) {
      await gateway.setMethodResponse("sessions.files.list", await listing(folder));
    }
    async function requestAt(count: number) {
      await expect
        .poll(async () => (await gateway.getRequests("sessions.files.upload")).length)
        .toBe(count);
      const request = (await gateway.getRequests("sessions.files.upload")).at(-1);
      expect(request).toBeDefined();
      return request!;
    }
    async function serveUpload(count: number, folder: string) {
      const request = await requestAt(count);
      const responses: Array<{
        ok: boolean;
        payload?: unknown;
        error?: { code: string; message: string; details?: unknown };
      }> = [];
      const respond: RespondFn = (ok, payload, error) => {
        responses.push({ ok, payload, error });
      };
      const handler = sessionsFilesUploadHandlers["sessions.files.upload"];
      expect(handler).toBeDefined();
      if (!request.params || typeof request.params !== "object" || Array.isArray(request.params)) {
        throw new Error("Expected an upload request object");
      }
      await handler!({
        req: { type: "req", id: request.id, method: request.method },
        params: request.params as Record<string, unknown>,
        context: {} as GatewayRequestContext,
        client: null,
        respond,
        isWebchatConnect: () => false,
      });
      expect(responses).toHaveLength(1);
      const response = responses[0]!;
      await updateListing(folder);
      if (response.ok) {
        await gateway.resolveDeferred("sessions.files.upload", response.payload);
      } else {
        await gateway.rejectDeferred("sessions.files.upload", response.error);
      }
      return response;
    }
    const input = page.locator(".chat-workspace-upload__input");
    const notice = page.locator(".chat-workspace-upload");
    const uploadButton = page.getByRole("button", { name: "Upload workspace files" });
    const captures: string[] = [];
    async function capture(name: string, panel = false) {
      const destination = path.join(screenshots, `${name}.png`);
      expect(await page.locator("body").textContent()).not.toContain(tempRoot);
      if (panel) {
        await page.locator(".chat-workspace-rail").screenshot({ path: destination });
      } else {
        await page.screenshot({ path: destination, fullPage: true });
      }
      captures.push(destination);
    }

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.locator(".chat-workspace-toggle").click();
      await uploadButton.waitFor();
      await capture("ready");
      const binary = Buffer.from([0, 1, 255, 127, 10]);
      await gateway.deferNext("sessions.files.upload");
      const chooserOpened = page.waitForEvent("filechooser");
      await uploadButton.click();
      const chooser = await chooserOpened;
      await chooser.setFiles({
        name: "sample binary.bin",
        mimeType: "application/octet-stream",
        buffer: binary,
      });
      const picked = await requestAt(1);
      expect(picked.params).toEqual({
        sessionKey,
        agentId: "main",
        path: "",
        name: "sample binary.bin",
        contentBase64: binary.toString("base64"),
      });
      await page.getByText("Uploading 1 of 1", { exact: true }).waitFor();
      await capture("progress");
      expect((await serveUpload(1, "")).ok).toBe(true);
      await page.getByText("Uploaded 1 workspace files", { exact: true }).waitFor();
      expect(await readFile(path.join(root, "sample binary.bin"))).toEqual(binary);
      await page
        .locator(".chat-workspace-rail__list--browser .chat-workspace-rail__file-name", {
          hasText: "sample binary.bin",
        })
        .waitFor();

      await updateListing("docs");
      await page
        .locator(".chat-workspace-rail__file--directory .chat-workspace-rail__file-open", {
          hasText: "docs",
        })
        .click();
      await page.locator(".chat-workspace-rail__file-name", { hasText: "existing.txt" }).waitFor();
      await gateway.deferNext("sessions.files.upload");
      await input.setInputFiles({
        name: "existing.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("replacement"),
      });
      expect((await serveUpload(2, "docs")).ok).toBe(false);
      await page.getByText("Workspace upload failed", { exact: true }).waitFor();
      expect(await notice.textContent()).toContain("Rename the local file");
      expect(await notice.textContent()).toContain("Folder: docs");
      expect(await notice.getByRole("button", { name: "Retry", exact: true }).count()).toBe(0);
      expect(await readFile(path.join(root, "docs", "existing.txt"), "utf8")).toBe(
        "original synthetic file",
      );
      await capture("duplicate");
      await capture("upload-duplicate-panel", true);

      await uploadButton.waitFor();
      await gateway.deferNext("sessions.files.upload");
      await input.setInputFiles({
        name: "renamed.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("synthetic recovery"),
      });
      expect((await requestAt(3)).params).toMatchObject({ path: "docs", name: "renamed.txt" });
      expect((await serveUpload(3, "docs")).ok).toBe(true);
      await page.getByText("Uploaded 1 workspace files", { exact: true }).waitFor();
      expect(await readFile(path.join(root, "docs", "renamed.txt"), "utf8")).toBe(
        "synthetic recovery",
      );

      await uploadButton.waitFor();
      await input.setInputFiles({
        name: "too-large.bin",
        mimeType: "application/octet-stream",
        buffer: Buffer.alloc(16 * 1024 * 1024 + 1),
      });
      await page
        .getByText("File exceeds the 16 MiB workspace upload limit: too-large.bin", { exact: true })
        .waitFor();
      expect(await gateway.getRequests("sessions.files.upload")).toHaveLength(3);
      await capture("size-error");

      await uploadButton.waitFor();
      await gateway.deferNext("sessions.files.upload");
      await input.setInputFiles([
        { name: "first.txt", mimeType: "text/plain", buffer: Buffer.from("first") },
        { name: "second.txt", mimeType: "text/plain", buffer: Buffer.from("second") },
      ]);
      await requestAt(4);
      await gateway.deferNext("sessions.files.upload");
      expect((await serveUpload(4, "docs")).ok).toBe(true);
      await requestAt(5);
      await gateway.rejectDeferred("sessions.files.upload", {
        code: "UNAVAILABLE",
        message: "Synthetic temporary failure",
      });
      await notice.getByRole("button", { name: "Retry", exact: true }).waitFor();
      await capture("transient-error");
      await gateway.deferNext("sessions.files.upload");
      await notice.getByRole("button", { name: "Retry", exact: true }).click();
      expect((await requestAt(6)).params).toMatchObject({ path: "docs", name: "second.txt" });
      expect((await serveUpload(6, "docs")).ok).toBe(true);
      await page.getByText("Uploaded 2 workspace files", { exact: true }).waitFor();
      expect(await readFile(path.join(root, "docs", "first.txt"), "utf8")).toBe("first");
      expect(await readFile(path.join(root, "docs", "second.txt"), "utf8")).toBe("second");
      await page.locator(".chat-workspace-rail__file-name", { hasText: "second.txt" }).waitFor();
      await capture("recovered");
      await capture("upload-result-panel", true);
      await page.setViewportSize({ width: 760, height: 900 });
      await expect
        .poll(() => page.locator(".chat-workbench").getAttribute("class"))
        .toContain("chat-workbench--dock-bottom");
      await capture("recovered-narrow");
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      expect(await gateway.getRequests("terminal.upload")).toHaveLength(0);
      process.stdout.write(
        `${JSON.stringify({ proof: "workspace-browser-upload", syntheticWorkspace: root, screenshots: captures, productionHandler: true, originalPreserved: true })}\n`,
      );
    } finally {
      await suite.closeBrowserContext(context);
      fixture.loadRoot.mockReset();
      expect(path.dirname(root)).toBe(tempRoot);
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
