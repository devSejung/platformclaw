import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createOrganizationMemoryClient } from "./client.js";

describe("vault internal client", () => {
  it.each(["success", "interrupted", "ambiguous", "query-invalid", "redacted"])(
    "settles scope capture with a %s response",
    async (mode) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "vault-client-"));
      const tokenFile = path.join(root, "token");
      await fs.writeFile(tokenFile, "test-service-token");
      const broker =
        process.platform === "win32"
          ? `\\\\.\\pipe\\vault-client-${crypto.randomUUID()}`
          : path.join(root, "broker.sock");
      const socketPath =
        process.platform === "win32" ? `${broker}-execution` : path.join(root, "execution.sock");
      const received: Array<{ url?: string; body: string }> = [];
      const server = createServer((req, res) => {
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (chunk: string) => {
          body += chunk;
        });
        req.on("end", () => {
          received.push({ url: req.url, body });
          res.writeHead(
            mode === "ambiguous" || mode === "query-invalid"
              ? 409
              : mode === "redacted"
                ? 500
                : 200,
            {
              "content-type": "application/json",
            },
          );
          if (mode === "interrupted") {
            res.write('{"revision":');
            setImmediate(() => res.destroy());
          } else if (mode === "ambiguous") {
            res.end(
              JSON.stringify({
                error: "Multiple accessible Vaults have that exact name",
                code: "vault-name-ambiguous",
                action: "Choose a Vault ID",
                vaultChoices: Array.from({ length: 6 }, (_, i) => ({
                  vaultId: `vault-${i}`,
                  vaultName: "PHY",
                  vaultType: "shared",
                })),
              }),
            );
          } else if (mode === "query-invalid") {
            res.end(
              JSON.stringify({
                error: "Search query requires 1-16 distinct words or identifiers",
                code: "vault-query-invalid",
                action: "Retry with fewer keywords.",
              }),
            );
          } else if (mode === "redacted") {
            res.end(JSON.stringify({ error: "private-database-path-and-content" }));
          } else {
            res.end(JSON.stringify({ revision: 4, vaultIds: ["managed:global"] }));
          }
        });
      });
      try {
        server.listen(socketPath);
        await once(server, "listening");
        const client = createOrganizationMemoryClient({
          PLATFORMCLAW_CREDENTIAL_BROKER_ADDRESS: broker,
          PLATFORMCLAW_EXECUTION_SERVICE_TOKEN_FILE: tokenFile,
        });
        expect(client).not.toBeNull();
        const capture = client!.captureScope({ agentId: "person_one" });
        if (mode === "interrupted") {
          await expect(capture).rejects.toThrow(/interrupted|socket hang up/u);
        } else if (mode === "ambiguous") {
          await expect(capture).rejects.toMatchObject({
            memoryCorpusFailure: {
              code: "vault-name-ambiguous",
              action: "Choose a Vault ID",
              vaultChoices: Array.from({ length: 5 }, (_, i) => ({
                vaultId: `vault-${i}`,
                vaultName: "PHY",
                vaultType: "shared",
              })),
            },
          });
        } else if (mode === "query-invalid") {
          await expect(capture).rejects.toMatchObject({
            memoryCorpusFailure: {
              code: "vault-query-invalid",
              action: "Retry with fewer keywords.",
            },
          });
        } else if (mode === "redacted") {
          await expect(capture).rejects.toMatchObject({
            message: "Memory Hub service is unavailable (500)",
            memoryCorpusFailure: { error: "Memory Hub service is unavailable (500)" },
          });
        } else {
          await expect(capture).resolves.toEqual({ revision: 4, vaultIds: ["managed:global"] });
        }
        expect(received).toEqual([
          { url: "/platformclaw/internal/memory/vaults/scope", body: '{"agentId":"person_one"}' },
        ]);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
});
