import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { parseMessageWithAttachments } from "./chat-attachments.js";
import { createGatewayHttpServer } from "./server-http.js";

describe("attachment HTTP access without the bundled UI", () => {
  it.each([
    { enabled: false, basePath: "" },
    { enabled: true, basePath: "" },
    { enabled: false, basePath: "/dashboard" },
  ])(
    "serves uploaded files with UI enabled=$enabled at '$basePath'",
    async ({ enabled, basePath }) => {
      const stateDir = await mkdtemp(path.join(tmpdir(), "gateway-upload-download-"));
      try {
        await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
          const server = createGatewayHttpServer({
            clients: new Set(),
            controlUiEnabled: enabled,
            controlUiBasePath: basePath,
            openAiChatCompletionsEnabled: false,
            openResponsesEnabled: false,
            handleHooksRequest: async () => false,
            resolvedAuth: { mode: "token", token: "attachment-test-token", allowTailscale: false },
            getRuntimeConfig: () => ({ gateway: { controlUi: { enabled } } }),
          });
          await new Promise<void>((resolve) => {
            server.listen(0, "127.0.0.1", resolve);
          });
          try {
            const address = server.address();
            if (!address || typeof address === "string") {
              throw new Error("expected an HTTP listener");
            }
            const origin = `http://127.0.0.1:${address.port}`;
            const content = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
            const uploaded = await parseMessageWithAttachments("read this PDF", [
              {
                type: "file",
                fileName: "보고서.pdf",
                mimeType: "application/pdf",
                content: content.toString("base64"),
              },
            ]);
            const attachment = uploaded.offloadedRefs[0];
            expect(attachment).toBeDefined();
            // The agent can read the upload even when the separate browser route is missing.
            expect(await readFile(attachment!.path)).toEqual(content);
            const route = `${origin}${basePath}/__openclaw__/assistant-media`;
            const query = new URLSearchParams({ source: attachment!.mediaRef });
            const metadata = await fetch(`${route}?${query}&meta=1`, {
              headers: { Authorization: "Bearer attachment-test-token" },
            });
            expect(metadata.status).toBe(200);
            const payload = (await metadata.json()) as { available: boolean; mediaTicket: string };
            expect(payload.available).toBe(true);
            expect((await fetch(`${route}?${query}`)).status).toBe(401);
            query.set("mediaTicket", payload.mediaTicket);
            const download = await fetch(`${route}?${query}`);
            expect(download.status).toBe(200);
            expect(Buffer.from(await download.arrayBuffer())).toEqual(content);
            if (!enabled) {
              expect((await fetch(`${origin}${basePath}/`)).status).toBe(404);
            }
          } finally {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => {
              server.close((error) => (error ? reject(error) : resolve()));
            });
          }
        });
      } finally {
        await rm(stateDir, { recursive: true, force: true });
      }
    },
  );
});
