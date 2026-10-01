import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlPlaneConflictError } from "./contracts.js";
import { ExecutionHandoffClient } from "./execution-handoff-client.js";
import {
  PlatformClawExecutionHandoffServer,
  parseSpaceReadRequest,
} from "./execution-handoff-http.js";
import type { ExecutionHandoffService } from "./execution-handoff-service.js";
import { KnowledgeVaultSearchError } from "./knowledge-vault-contracts.js";

const servers: PlatformClawExecutionHandoffServer[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => await server.close()));
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

async function startServer() {
  const vaultHit = {
    vaultId: "vault-one",
    vaultName: "DDRPHY",
    vaultType: "shared" as const,
    documentId: "doc-one",
    path: "shared/vault-one/doc-one",
    title: "Training",
    snippet: "Reviewed training facts.",
    revision: 3,
    score: 0.9,
  };
  const service = {
    vaultService: {
      captureScope: vi.fn(() => ({ revision: 4, vaultIds: ["vault-one"], personalEnabled: true })),
      wiki: vi.fn(() => ({
        text: "Wiki status",
        details: { wikis: [], totalWikis: 0, truncated: false },
      })),
      search: vi.fn(async () => [vaultHit]),
      get: vi.fn(async () => ({
        ...vaultHit,
        revision: "3",
        editMode: "body",
        editableContent: "Reviewed training facts.",
        totalLines: 2,
        truncated: true,
        content: "Reviewed training facts.",
        fromLine: 2,
        lineCount: 1,
        logicalPath: "training.md",
        link: "[[training.md]]",
      })),
    },
    resolveTarget: vi.fn(async (agentId: string) => ({
      kind: "platform_server" as const,
      agentId,
      targetId: "platform-server" as const,
      revision: 0,
    })),
    issueCredentialGrant: vi.fn(async () => ({
      token: "grant-token",
      expiresAt: 30_000,
      brokerAddress: "/run/platformclaw/runtime.sock",
      agentId: "person_one",
      allocationId: "allocation-one",
      targetRevision: 4,
      credentialRevision: 3,
    })),
    resolveConnectionTarget: vi.fn(),
    changeTarget: vi.fn(),
    resolveMcpConnection: vi.fn(async () => ({
      headers: { Authorization: "Bearer secret" },
      revision: 2,
      expiresAt: 60_000,
    })),
  };
  const root = await mkdtemp(join(tmpdir(), "platformclaw-handoff-"));
  roots.push(root);
  const socketPath =
    process.platform === "win32"
      ? String.raw`\\.\pipe\platformclaw-handoff-${randomUUID()}`
      : join(root, "execution.sock");
  const server = new PlatformClawExecutionHandoffServer(
    "service-token-that-is-at-least-32-bytes",
    service,
    socketPath,
  );
  servers.push(server);
  await server.listen();
  return { service, socketPath };
}

async function post(socketPath: string, pathname: string, body: unknown): Promise<unknown> {
  const response = await postResponse(socketPath, pathname, body);
  if (response.status >= 300) {
    throw new Error(`request failed (${response.status})`);
  }
  return response.body;
}

async function postResponse(
  socketPath: string,
  pathname: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  const payload = Buffer.from(JSON.stringify(body));
  return await new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path: pathname,
        method: "POST",
        headers: {
          authorization: "Bearer service-token-that-is-at-least-32-bytes",
          "content-type": "application/json",
          "content-length": payload.length,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 500,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          }),
        );
      },
    );
    req.once("error", reject);
    req.end(payload);
  });
}

describe("PlatformClawExecutionHandoffServer", () => {
  it("forwards the frozen Wiki scope and explicit revision, returning actionable conflicts", async () => {
    const { socketPath, service } = await startServer();
    const turnScope = { revision: 4, vaultIds: ["vault-one"], personalEnabled: false };
    const mutation = {
      op: "update",
      lookup: "shared/vault-one/doc-one",
      body: "Updated body",
      expectedRevision: "3",
    };
    await expect(
      post(socketPath, "/platformclaw/internal/memory/vaults/wiki", {
        agentId: "person_one",
        vaultId: "vault-one",
        operation: "apply",
        turnScope,
        mutation,
      }),
    ).resolves.toEqual({
      text: "Wiki status",
      details: { wikis: [], totalWikis: 0, truncated: false },
    });
    expect(service.vaultService.wiki).toHaveBeenCalledWith({
      agentId: "person_one",
      vaultId: "vault-one",
      vaultName: undefined,
      operation: "apply",
      turnScope,
      mutation,
    });
    service.vaultService.wiki.mockImplementationOnce(() => {
      throw new ControlPlaneConflictError("knowledge_vault_changed", "Document changed");
    });
    await expect(
      postResponse(socketPath, "/platformclaw/internal/memory/vaults/wiki", {
        agentId: "person_one",
        vaultId: "vault-one",
        operation: "apply",
        mutation,
      }),
    ).resolves.toMatchObject({
      status: 409,
      body: {
        code: "wiki-conflict",
        error: "Document changed",
        action: expect.stringContaining("read the current document"),
      },
    });
    const calls = service.vaultService.wiki.mock.calls.length;
    await expect(
      postResponse(socketPath, "/platformclaw/internal/memory/vaults/wiki", {
        agentId: "person_one",
        operation: "apply",
        mutation: { ...mutation, expectedRevision: 3 },
      }),
    ).resolves.toMatchObject({ status: 409, body: { code: "wiki-invalid" } });
    expect(service.vaultService.wiki).toHaveBeenCalledTimes(calls);
  });
  it("rejects an incorrect service token before dispatch", async () => {
    const { socketPath, service } = await startServer();
    const client = new ExecutionHandoffClient(socketPath, "wrong-token");

    await expect(client.resolveTarget("person_one")).rejects.toThrow("(401)");
    expect(service.resolveTarget).not.toHaveBeenCalled();
  });

  it("serves target and grant calls only to the authenticated local client", async () => {
    const { socketPath, service } = await startServer();
    const client = new ExecutionHandoffClient(
      socketPath,
      "service-token-that-is-at-least-32-bytes",
    );

    await expect(client.resolveTarget("person_one")).resolves.toMatchObject({
      kind: "platform_server",
      agentId: "person_one",
    });
    await expect(
      client.issueCredentialGrant({
        agentId: "person_one",
        allocationId: "allocation-one",
        targetRevision: 4,
        credentialRevision: 3,
      }),
    ).resolves.toMatchObject({
      token: "grant-token",
      allocationId: "allocation-one",
      targetRevision: 4,
    });
    expect(service.issueCredentialGrant).toHaveBeenCalledWith({
      agentId: "person_one",
      allocationId: "allocation-one",
      targetRevision: 4,
      credentialRevision: 3,
    });
    expect(service.resolveTarget).toHaveBeenCalledWith("person_one");
    await expect(
      client.resolveMcpConnection("person_one", "github", "https://mcp.example.test/github"),
    ).resolves.toEqual({
      headers: { Authorization: "Bearer secret" },
      revision: 2,
      expiresAt: 60_000,
    });
    expect(service.resolveMcpConnection).toHaveBeenCalledWith(
      "person_one",
      "github",
      "https://mcp.example.test/github",
    );
  });

  it("rejects retired organization knowledge endpoints", async () => {
    const { socketPath } = await startServer();
    for (const path of ["search", "get"]) {
      await expect(
        post(socketPath, `/platformclaw/internal/memory/organization/${path}`, {
          agentId: "person_one",
        }),
      ).rejects.toThrow();
    }
  });

  it("delegates vault search and get with agent identity, optional scope and complete provenance", async () => {
    const { socketPath, service } = await startServer();
    await expect(
      post(socketPath, "/platformclaw/internal/memory/vaults/scope", { agentId: "person_one" }),
    ).resolves.toEqual({ revision: 4, vaultIds: ["vault-one"], personalEnabled: true });
    expect(service.vaultService.captureScope).toHaveBeenCalledWith({ agentId: "person_one" });
    await expect(
      post(socketPath, "/platformclaw/internal/memory/vaults/search", {
        agentId: "person_one",
        query: "training",
        vaultId: "vault-one",
        maxResults: 5,
      }),
    ).resolves.toEqual([
      {
        vaultId: "vault-one",
        vaultName: "DDRPHY",
        vaultType: "shared",
        documentId: "doc-one",
        path: "shared/vault-one/doc-one",
        title: "Training",
        snippet: "Reviewed training facts.",
        revision: 3,
        score: 0.9,
      },
    ]);
    expect(service.vaultService.search).toHaveBeenCalledWith({
      agentId: "person_one",
      query: "training",
      vaultId: "vault-one",
      maxResults: 5,
    });
    await post(socketPath, "/platformclaw/internal/memory/vaults/search", {
      agentId: "person_one",
      query: "training",
    });
    expect(service.vaultService.search).toHaveBeenLastCalledWith({
      agentId: "person_one",
      query: "training",
    });
    await post(socketPath, "/platformclaw/internal/memory/vaults/search", {
      agentId: "person_one",
      query: "training",
      vaultName: "DDRPHY",
    });
    expect(service.vaultService.search).toHaveBeenLastCalledWith({
      agentId: "person_one",
      query: "training",
      vaultName: "DDRPHY",
    });
    // A complete bounded selection may exceed the small execution-command body limit.
    const turnScope = {
      personalEnabled: true,
      revision: 4,
      vaultIds: Array.from({ length: 128 }, () => randomUUID()),
    };
    await post(socketPath, "/platformclaw/internal/memory/vaults/search", {
      agentId: "person_one",
      query: "training",
      turnScope,
    });
    expect(service.vaultService.search).toHaveBeenLastCalledWith({
      agentId: "person_one",
      query: "training",
      turnScope,
    });
    await expect(
      post(socketPath, "/platformclaw/internal/memory/vaults/get", {
        agentId: "person_one",
        path: "shared/vault-one/doc-one",
        fromLine: 2,
        lineCount: 20,
      }),
    ).resolves.toMatchObject({
      vaultId: "vault-one",
      documentId: "doc-one",
      revision: "3",
      content: "Reviewed training facts.",
    });
    expect(service.vaultService.get).toHaveBeenCalledWith({
      agentId: "person_one",
      path: "shared/vault-one/doc-one",
      fromLine: 2,
      lineCount: 20,
    });
  });

  it("rejects invalid vault query and document bounds before service dispatch", async () => {
    const { socketPath, service } = await startServer();
    for (const invalid of [
      { query: "" },
      { maxResults: 51 },
      { vaultId: "v".repeat(257) },
      { vaultName: " " },
      { vaultName: 1 },
      { vaultName: "v".repeat(241) },
      { vaultId: "vault-one", vaultName: "DDRPHY" },
      { turnScope: { revision: -1, vaultIds: [] } },
      { turnScope: { revision: 1, vaultIds: ["vault-one", "vault-one"] } },
      { turnScope: { revision: 1, vaultIds: ["../private"] } },
      { turnScope: { revision: 1, vaultIds: Array.from({ length: 257 }, (_, i) => `v${i}`) } },
    ]) {
      await expect(
        post(socketPath, "/platformclaw/internal/memory/vaults/search", {
          agentId: "person_one",
          query: "training",
          ...invalid,
        }),
      ).rejects.toThrow("(400)");
    }
    for (const invalid of [{ fromLine: 0 }, { lineCount: 201 }, { path: "p".repeat(1025) }]) {
      await expect(
        post(socketPath, "/platformclaw/internal/memory/vaults/get", {
          agentId: "person_one",
          path: "shared/vault-one/doc-one",
          ...invalid,
        }),
      ).rejects.toThrow("(400)");
    }
    expect(service.vaultService.search).not.toHaveBeenCalled();
    expect(service.vaultService.get).not.toHaveBeenCalled();
  });

  it("returns owner-authorized name choices and hides unexpected search failures", async () => {
    const { socketPath, service } = await startServer();
    const choices = [{ vaultId: "vault-one", vaultName: "DDRPHY", vaultType: "shared" as const }];
    service.vaultService.search.mockRejectedValueOnce(
      new KnowledgeVaultSearchError(
        "vault-name-ambiguous",
        "Multiple accessible Vaults have this name.",
        "Ask the user which Vault to use, then retry with its vaultId.",
        choices,
      ),
    );
    const searchRequest = { agentId: "person_one", query: "training", vaultName: "DDRPHY" };
    await expect(
      postResponse(socketPath, "/platformclaw/internal/memory/vaults/search", searchRequest),
    ).resolves.toEqual({
      status: 409,
      body: {
        error: "Multiple accessible Vaults have this name.",
        code: "vault-name-ambiguous",
        action: "Ask the user which Vault to use, then retry with its vaultId.",
        vaultChoices: choices,
      },
    });
    service.vaultService.search.mockRejectedValueOnce(new Error("internal SQLite location"));
    await expect(
      postResponse(socketPath, "/platformclaw/internal/memory/vaults/search", searchRequest),
    ).resolves.toEqual({ status: 409, body: { error: "execution target unavailable" } });
  });

  it.runIf(process.platform !== "win32")(
    "does not unlink an active handoff socket during overlapping startup",
    async () => {
      const { socketPath } = await startServer();
      const replacement = new PlatformClawExecutionHandoffServer(
        "replacement-token-that-is-at-least-32-bytes",
        {
          resolveTarget: vi.fn(),
          resolveConnectionTarget: vi.fn(),
          changeTarget: vi.fn(),
          issueCredentialGrant: vi.fn(),
        },
        socketPath,
      );

      await expect(replacement.listen()).rejects.toThrow("already active");
      const client = new ExecutionHandoffClient(
        socketPath,
        "service-token-that-is-at-least-32-bytes",
      );
      await expect(client.resolveTarget("person_one")).resolves.toMatchObject({
        agentId: "person_one",
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "serializes concurrent recovery of a stale socket",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "platformclaw-handoff-stale-"));
      roots.push(root);
      const socketPath = join(root, "execution.sock");
      const staleOwner = spawn(
        process.execPath,
        [
          "-e",
          'require("node:net").createServer().listen(process.argv[1], () => process.stdout.write("ready"))',
          socketPath,
        ],
        { stdio: ["ignore", "pipe", "inherit"] },
      );
      await once(staleOwner.stdout, "data");
      staleOwner.kill("SIGKILL");
      await once(staleOwner, "exit");

      const service = {
        resolveTarget: vi.fn(async (agentId: string) => ({
          kind: "platform_server" as const,
          agentId,
          targetId: "platform-server" as const,
          revision: 0,
        })),
        issueCredentialGrant: vi.fn(),
        resolveConnectionTarget: vi.fn(),
        changeTarget: vi.fn(),
      } satisfies Pick<
        ExecutionHandoffService,
        "resolveTarget" | "resolveConnectionTarget" | "changeTarget" | "issueCredentialGrant"
      >;
      const candidates = [
        new PlatformClawExecutionHandoffServer(
          "shared-service-token-that-is-at-least-32-bytes",
          service,
          socketPath,
        ),
        new PlatformClawExecutionHandoffServer(
          "shared-service-token-that-is-at-least-32-bytes",
          service,
          socketPath,
        ),
      ];
      const results = await Promise.allSettled(
        candidates.map(async (server) => await server.listen()),
      );
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      const winnerIndex = results.findIndex((result) => result.status === "fulfilled");
      const winner = candidates[winnerIndex];
      if (!winner) {
        throw new Error("expected one execution handoff startup to succeed");
      }
      servers.push(winner);

      const client = new ExecutionHandoffClient(
        socketPath,
        "shared-service-token-that-is-at-least-32-bytes",
      );
      await expect(client.resolveTarget("person_one")).resolves.toMatchObject({
        agentId: "person_one",
      });
    },
  );

  it("returns a redacted failure for unavailable targets", async () => {
    const { socketPath, service } = await startServer();
    service.resolveTarget.mockRejectedValueOnce(new Error("private database detail"));
    const client = new ExecutionHandoffClient(
      socketPath,
      "service-token-that-is-at-least-32-bytes",
    );

    const failure = client.resolveTarget("person_one");
    await expect(failure).rejects.toThrow("(409)");
    await expect(failure).rejects.not.toThrow("private database detail");
  });

  it("rejects a response that is interrupted before completion", async () => {
    const root = await mkdtemp(join(tmpdir(), "platformclaw-handoff-abort-"));
    roots.push(root);
    const socketPath =
      process.platform === "win32"
        ? String.raw`\\.\pipe\platformclaw-handoff-abort-${randomUUID()}`
        : join(root, "execution.sock");
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"kind":');
      setImmediate(() => response.destroy());
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });

    try {
      const client = new ExecutionHandoffClient(
        socketPath,
        "service-token-that-is-at-least-32-bytes",
      );
      await expect(client.resolveTarget("person_one")).rejects.toThrow(
        "execution handoff response was aborted",
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

it("validates source anchors in the same parser used by internal Space reads", () => {
  const input = {
    agentId: "person_one",
    operation: "get",
    spaceId: "space-one",
    pageId: "page-one",
    messageId: "old-message",
  };
  expect(parseSpaceReadRequest(input, "person_one")).toEqual(input);
  expect(() => parseSpaceReadRequest({ ...input, userId: "forged" }, "person_one")).toThrow(
    "Invalid Space read",
  );
});
