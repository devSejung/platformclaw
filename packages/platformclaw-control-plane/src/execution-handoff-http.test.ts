import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExecutionHandoffClient } from "./execution-handoff-client.js";
import { PlatformClawExecutionHandoffServer } from "./execution-handoff-http.js";
import type { ExecutionHandoffService } from "./execution-handoff-service.js";

const servers: PlatformClawExecutionHandoffServer[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => await server.close()));
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

async function startServer() {
  const service = {
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
    searchOrganizationMemory: vi.fn(async () => [
      {
        id: "page-1",
        path: "organization/global/page-1",
        scopeKind: "global" as const,
        scopeName: "Global",
        title: "Security policy",
        snippet: "Use approved devices.",
        score: 0.9,
        updatedAt: 1_000,
      },
    ]),
    getOrganizationMemory: vi.fn(async () => ({
      id: "page-1",
      path: "organization/global/page-1",
      scopeKind: "global" as const,
      scopeName: "Global",
      title: "Security policy",
      snippet: "Use approved devices.",
      score: 0.9,
      updatedAt: 1_000,
      content: "Use approved devices.",
      fromLine: 1,
      lineCount: 1,
    })),
  } satisfies Pick<
    ExecutionHandoffService,
    "resolveTarget" | "resolveConnectionTarget" | "changeTarget" | "issueCredentialGrant"
  > & {
    resolveMcpConnection(
      agentId: string,
      serverName: string,
      serverUrl: string,
    ): Promise<{
      headers: Record<string, string>;
      revision: number;
      expiresAt?: number;
    }>;
    searchOrganizationMemory(params: {
      agentId: string;
      query: string;
      maxResults?: number;
    }): Promise<unknown[]>;
    getOrganizationMemory(params: {
      agentId: string;
      path: string;
      fromLine?: number;
      lineCount?: number;
    }): Promise<unknown>;
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
          (res.statusCode ?? 500) < 300
            ? resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")))
            : reject(new Error(`request failed (${res.statusCode ?? 500})`)),
        );
      },
    );
    req.once("error", reject);
    req.end(payload);
  });
}

describe("PlatformClawExecutionHandoffServer", () => {
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

  it("serves bounded organization memory using the agent-scoped owner", async () => {
    const { socketPath, service } = await startServer();
    await expect(
      post(socketPath, "/platformclaw/internal/memory/organization/search", {
        agentId: "person_one",
        query: "security",
        maxResults: 5,
      }),
    ).resolves.toEqual([expect.objectContaining({ path: "organization/global/page-1" })]);
    await expect(
      post(socketPath, "/platformclaw/internal/memory/organization/get", {
        agentId: "person_one",
        path: "organization/global/page-1",
        fromLine: 1,
        lineCount: 20,
      }),
    ).resolves.toMatchObject({ content: "Use approved devices.", lineCount: 1 });
    expect(service.searchOrganizationMemory).toHaveBeenCalledWith({
      agentId: "person_one",
      query: "security",
      maxResults: 5,
    });
    expect(service.getOrganizationMemory).toHaveBeenCalledWith({
      agentId: "person_one",
      path: "organization/global/page-1",
      fromLine: 1,
      lineCount: 20,
    });
    await expect(
      post(socketPath, "/platformclaw/internal/memory/organization/get", {
        agentId: "person_one",
        path: "file:///srv/private",
      }),
    ).rejects.toThrow("(400)");
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
