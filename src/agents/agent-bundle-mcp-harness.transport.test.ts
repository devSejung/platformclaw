/** Real MCP transport coverage for trusted harness identity and per-session policy. */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionToolOverrides } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { materializeRequesterScopedMcpToolsForHarnessRun } from "../plugin-sdk/agent-harness-runtime.js";
import { getPluginToolMeta } from "../plugins/tools.js";
import {
  disposeAgentScopedMcpRuntimes,
  disposeAllSessionMcpRuntimes,
} from "./agent-bundle-mcp-manager-api.js";
import { createSessionMcpRuntime } from "./agent-bundle-mcp-runtime.js";
import { testing } from "./mcp-connection-resolver.js";

async function startPersonalMcpServer() {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const sseTransports = new Map<string, SSEServerTransport>();
  const servers: McpServer[] = [];
  const calls: string[] = [];
  let unauthorized = 0;
  function createMcpServer(owner: string) {
    const mcp = new McpServer({ name: "personal-mcp-proof", version: "1" });
    for (const name of ["read_record", "write_record"]) {
      mcp.registerTool(name, { description: name }, async () => {
        calls.push(`${owner}:${name}`);
        return { content: [{ type: "text" as const, text: `${owner}:${name}` }] };
      });
    }
    mcp.registerResource("record", "fixture://record", {}, async (uri) => ({
      contents: [{ uri: uri.href, text: owner }],
    }));
    servers.push(mcp);
    return mcp;
  }
  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://fixture");
      const isSse = url.pathname.startsWith("/sse/");
      const owner = url.pathname.slice(isSse ? 5 : 1);
      if (!owner || req.headers.authorization !== `Bearer fixture-${owner}`) {
        unauthorized += 1;
        res.writeHead(401).end();
        return;
      }
      if (isSse) {
        if (req.method === "GET") {
          const transport = new SSEServerTransport(url.pathname, res);
          sseTransports.set(transport.sessionId, transport);
          await createMcpServer(owner).connect(transport);
        } else {
          const transport = sseTransports.get(url.searchParams.get("sessionId") ?? "");
          if (req.method !== "POST" || !transport) {
            res.writeHead(400).end();
            return;
          }
          await transport.handlePostMessage(req, res);
        }
        return;
      }
      const sessionId = req.headers["mcp-session-id"];
      let transport = typeof sessionId === "string" ? transports.get(sessionId) : undefined;
      if (!transport) {
        if (req.method !== "POST") {
          res.writeHead(405).end();
          return;
        }
        const mcp = createMcpServer(owner);
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          onsessioninitialized: (id) => {
            transports.set(id, transport!);
          },
        });
        await mcp.connect(transport);
      }
      await transport.handleRequest(req, res);
    })().catch(() => {
      if (!res.headersSent) {
        res.writeHead(500).end();
      }
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("MCP test server did not acquire a port");
  }
  return {
    url: (owner: string, transport?: "sse") =>
      `http://127.0.0.1:${address.port}/${transport === "sse" ? "sse/" : ""}${owner}`,
    calls,
    get unauthorized() {
      return unauthorized;
    },
    close: async () => {
      await Promise.all(servers.map((mcp) => mcp.close()));
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

describe("harness MCP identity, policy, and config over real transports", () => {
  let fixture: Awaited<ReturnType<typeof startPersonalMcpServer>>;
  let workspaceDir: string;
  let cfg: OpenClawConfig;
  let available: boolean;
  const manifestRegistry = { plugins: [] };

  beforeEach(async () => {
    workspaceDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "harness-mcp-")));
    fixture = await startPersonalMcpServer();
    available = true;
    cfg = {
      plugins: { enabled: false },
      mcp: {
        servers: {
          personal: { url: fixture.url("placeholder"), transport: "streamable-http" },
        },
      },
    };
    testing.setMcpServerConnectionResolversForTest([
      {
        serverName: "personal",
        resolve: async ({ requesterSenderId }) =>
          available
            ? {
                url: fixture.url(requesterSenderId),
                headers: { Authorization: `Bearer fixture-${requesterSenderId}` },
              }
            : null,
        resolveForAgent: async ({ agentId }) =>
          available && agentId !== "missing"
            ? {
                url: fixture.url(agentId),
                headers: { Authorization: `Bearer fixture-${agentId}` },
              }
            : null,
      },
    ]);
  });

  afterEach(async () => {
    await disposeAllSessionMcpRuntimes();
    testing.setMcpServerConnectionResolversForTest(null);
    await fixture?.close();
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  const names = (
    runtime: NonNullable<
      Awaited<ReturnType<typeof materializeRequesterScopedMcpToolsForHarnessRun>>
    >,
  ) => ({
    executable: runtime?.tools.map((tool) => tool.name) ?? [],
    advertised: runtime?.advertisedTools.map((tool) => tool.name) ?? [],
  });

  async function materialize(params: {
    sessionId?: string;
    agentId?: string;
    requesterSenderId?: string;
    toolOverrides?: Pick<SessionToolOverrides, "mcpServers" | "mcpToolsDeny">;
  }) {
    return await materializeRequesterScopedMcpToolsForHarnessRun({
      sessionId: "shared-session",
      workspaceDir,
      cfg,
      manifestRegistry,
      ...params,
    });
  }

  it("keeps a URL-only SSE server working after personal credentials are attached", async () => {
    cfg = {
      plugins: { enabled: false },
      mcp: {
        servers: {
          personal: {
            url: fixture.url("alice", "sse"),
            headers: { Authorization: "Bearer fixture-alice" },
          },
        },
      },
    };
    const before = createSessionMcpRuntime({
      sessionId: "static-sse",
      workspaceDir,
      cfg,
      manifestRegistry,
    });
    try {
      expect((await before.getCatalog()).tools.map((tool) => tool.toolName)).toContain(
        "read_record",
      );
    } finally {
      await before.dispose();
    }
    testing.setMcpServerConnectionResolversForTest([
      {
        serverName: "personal",
        resolve: async () => null,
        resolveForAgent: async () => ({
          url: fixture.url("alice", "sse"),
          headers: { Authorization: "Bearer fixture-alice" },
        }),
      },
    ]);
    const after = await materialize({ agentId: "alice" });
    const read = after?.tools.find((tool) => tool.name === "personal__read_record");
    expect(read).toBeDefined();
    expect((await read!.execute("sse", {})).content).toEqual([
      { type: "text", text: "alice:read_record" },
    ]);
    expect(fixture.unauthorized).toBe(0);
    await after!.dispose();
  });

  it.each(["removed", "disabled", "filter", "url", "headers"] as const)(
    "drops the old advertised catalog after the declaration is %s without credentials",
    async (change) => {
      const initial = await materialize({ agentId: "alice" });
      expect(names(initial!).advertised).toContain("personal__write_record");
      await initial!.dispose();
      const declaration = cfg.mcp!.servers!.personal;
      cfg = {
        ...cfg,
        mcp: {
          servers:
            change === "removed"
              ? {}
              : {
                  personal: {
                    ...declaration,
                    ...(change === "disabled" ? { enabled: false } : {}),
                    ...(change === "filter" ? { toolFilter: { include: ["read_record"] } } : {}),
                    ...(change === "url" ? { url: fixture.url("changed") } : {}),
                    ...(change === "headers" ? { headers: { "X-Config": "changed" } } : {}),
                  },
                },
        },
      };
      available = false;
      const next = await materialize({});
      expect(next?.advertisedTools ?? []).toEqual([]);
      expect(next?.tools ?? []).toEqual([]);
      await next?.dispose();
    },
  );

  it("uses a replaced declared endpoint immediately within credential revalidation", async () => {
    cfg = {
      plugins: { enabled: false },
      mcp: {
        servers: {
          personal: {
            transport: "streamable-http",
            url: fixture.url("alice"),
            headers: { Authorization: "Bearer fixture-alice" },
          },
        },
      },
    };
    testing.setMcpServerConnectionResolversForTest([
      {
        serverName: "personal",
        resolve: async () => null,
        resolveForAgent: async () => ({
          url: cfg.mcp!.servers!.personal!.url!,
          headers: Object.fromEntries(
            Object.entries(cfg.mcp!.servers!.personal!.headers ?? {}).map(([name, value]) => [
              name,
              String(value),
            ]),
          ),
        }),
      },
    ]);
    const initial = await materialize({ agentId: "same-agent" });
    const read = (runtime: NonNullable<typeof initial>) =>
      runtime.tools.find((tool) => tool.name === "personal__read_record")!;
    expect((await read(initial!).execute("initial", {})).content).toEqual([
      { type: "text", text: "alice:read_record" },
    ]);
    cfg = {
      ...cfg,
      mcp: {
        servers: {
          personal: {
            transport: "streamable-http",
            url: fixture.url("bob"),
            headers: { Authorization: "Bearer fixture-bob" },
          },
        },
      },
    };
    const replaced = await materialize({ agentId: "same-agent" });
    expect((await read(replaced!).execute("replaced", {})).content).toEqual([
      { type: "text", text: "bob:read_record" },
    ]);
    expect(fixture.calls).toEqual(["alice:read_record", "bob:read_record"]);
    expect(fixture.unauthorized).toBe(0);
    await Promise.all([initial!.dispose(), replaced!.dispose()]);
  });

  it("uses host-selected agent identity without a sender and preserves sender-only resolvers", async () => {
    const alice = await materialize({ agentId: "alice" });
    const bob = await materialize({ agentId: "bob", requesterSenderId: "alice" });
    expect(alice).toBeDefined();
    expect(bob).toBeDefined();
    const read = (runtime: NonNullable<typeof alice>) =>
      runtime.tools.find((tool) => tool.name === "personal__read_record")!;
    expect((await read(alice!).execute("a", {})).content).toEqual([
      { type: "text", text: "alice:read_record" },
    ]);
    expect((await read(bob!).execute("b", {})).content).toEqual([
      { type: "text", text: "bob:read_record" },
    ]);
    const missing = await materialize({ agentId: "missing" });
    expect((await read(missing!).execute("missing", {})).details).toMatchObject({
      status: "error",
    });
    expect(await disposeAgentScopedMcpRuntimes("alice")).toBe(1);
    await expect(read(alice!).execute("retired", {})).rejects.toThrow(/disposed/i);
    expect((await read(bob!).execute("still-bob", {})).content).toEqual([
      { type: "text", text: "bob:read_record" },
    ]);
    const senderOnly = await materialize({ requesterSenderId: "legacy" });
    expect((await read(senderOnly!).execute("legacy", {})).content).toEqual([
      { type: "text", text: "legacy:read_record" },
    ]);
    expect(fixture.unauthorized).toBe(0);
    await Promise.all([
      alice!.dispose(),
      bob!.dispose(),
      missing!.dispose(),
      senderOnly!.dispose(),
    ]);
  });

  it("retires an agent's live tools and advertised schemas without changing another session", async () => {
    const alice = await materialize({ agentId: "alice" });
    const bob = await materialize({ agentId: "bob", sessionId: "bob-session" });
    const read = (runtime: NonNullable<typeof alice>) =>
      runtime.tools.find((tool) => tool.name === "personal__read_record")!;
    expect((await read(alice!).execute("before", {})).content).toEqual([
      { type: "text", text: "alice:read_record" },
    ]);

    available = false;
    expect(await disposeAgentScopedMcpRuntimes("alice", { retireSessionCatalog: true })).toBe(1);
    await expect(read(alice!).execute("retired", {})).rejects.toThrow(/disposed/i);
    const disabled = await materialize({ agentId: "alice" });
    expect(disabled?.tools ?? []).toEqual([]);
    expect(disabled?.advertisedTools ?? []).toEqual([]);
    expect((await read(bob!).execute("unaffected", {})).content).toEqual([
      { type: "text", text: "bob:read_record" },
    ]);
    expect(fixture.calls).toEqual(["alice:read_record", "bob:read_record"]);

    available = true;
    const restored = await materialize({ agentId: "alice" });
    expect(names(restored!)).toEqual(names(alice!));
    expect((await read(restored!).execute("restored", {})).content).toEqual([
      { type: "text", text: "alice:read_record" },
    ]);
    expect(fixture.unauthorized).toBe(0);
    await Promise.all([alice!.dispose(), bob!.dispose(), restored!.dispose()]);
  });

  it("removes session-denied tools and disabled servers from live and cached surfaces", async () => {
    const initial = await materialize({ agentId: "alice", requesterSenderId: "alice" });
    expect(names(initial!).advertised).toContain("personal__write_record");
    await initial!.dispose();
    const toolOverrides = { mcpToolsDeny: { personal: ["write_record"] } };
    const denied = await materialize({
      agentId: "alice",
      requesterSenderId: "alice",
      toolOverrides,
    });
    expect(names(denied!).advertised).not.toContain("personal__write_record");
    expect(names(denied!).executable).toEqual(names(denied!).advertised);
    await denied!.dispose();
    available = false;
    const offline = await materialize({
      agentId: "missing",
      requesterSenderId: "missing",
      toolOverrides,
    });
    expect(names(offline!).advertised).not.toContain("personal__write_record");
    expect(names(offline!).executable).toEqual(names(offline!).advertised);
    await offline!.dispose();
    const disabled = await materialize({
      agentId: "alice",
      requesterSenderId: "alice",
      toolOverrides: { mcpServers: { personal: false } },
    });
    expect(names(disabled!)).toEqual({ executable: [], advertised: [] });
    await disabled?.dispose();
    available = true;
    const restored = await materialize({ agentId: "alice", requesterSenderId: "alice" });
    const write = restored!.tools.find((tool) => tool.name === "personal__write_record")!;
    expect((await write.execute("restored", {})).content).toEqual([
      { type: "text", text: "alice:write_record" },
    ]);
    expect(fixture.calls).toEqual(["alice:write_record"]);
    expect(fixture.unauthorized).toBe(0);
    await restored!.dispose();
  });

  it("keeps the correct authority when disabled servers change safe-name collisions", async () => {
    const firstName = "same-prefix-for-personal-servers-0";
    const secondName = "same-prefix-for-personal-servers-1";
    cfg = {
      plugins: { enabled: false },
      mcp: {
        servers: Object.fromEntries(
          [firstName, secondName].map((name) => [
            name,
            { url: fixture.url("placeholder"), transport: "streamable-http" },
          ]),
        ),
      },
    };
    testing.setMcpServerConnectionResolversForTest(
      [firstName, secondName].map((serverName, index) => {
        const owner = index === 0 ? "alice" : "bob";
        return {
          serverName,
          resolve: async () => ({
            url: fixture.url(owner),
            headers: { Authorization: `Bearer fixture-${owner}` },
          }),
        };
      }),
    );
    const initial = await materialize({ requesterSenderId: "sender" });
    await initial!.dispose();
    const remaining = await materialize({
      requesterSenderId: "sender",
      toolOverrides: { mcpServers: { [firstName]: false } },
    });
    expect(
      remaining!.tools.every((tool) => getPluginToolMeta(tool)?.mcp?.serverName === secondName),
    ).toBe(true);
    const read = remaining!.tools.find(
      (tool) => getPluginToolMeta(tool)?.mcp?.toolName === "read_record",
    )!;
    expect((await read.execute("remaining", {})).content).toEqual([
      { type: "text", text: "bob:read_record" },
    ]);
    expect(names(remaining!).executable).toEqual(names(remaining!).advertised);
    expect(fixture.calls).toEqual(["bob:read_record"]);
    expect(fixture.unauthorized).toBe(0);
    await remaining!.dispose();
  });

  it("updates utility permissions when listed MCP tools do not change", async () => {
    const initial = await materialize({ agentId: "alice", requesterSenderId: "alice" });
    expect(names(initial!).advertised).toContain("personal__resources_read");
    await initial!.dispose();
    const denied = await materialize({
      agentId: "alice",
      requesterSenderId: "alice",
      toolOverrides: { mcpToolsDeny: { personal: ["resources_read"] } },
    });
    expect(names(denied!).advertised).not.toContain("personal__resources_read");
    expect(names(denied!).executable).toEqual(names(denied!).advertised);
    await denied!.dispose();
    const restored = await materialize({ agentId: "alice", requesterSenderId: "alice" });
    expect(names(restored!).advertised).toContain("personal__resources_read");
    const resource = restored!.tools.find((tool) => tool.name === "personal__resources_read")!;
    expect(
      (await resource.execute("resource", { uri: "fixture://record" })).content[0],
    ).toMatchObject({ type: "text" });
    expect(fixture.unauthorized).toBe(0);
    await restored!.dispose();
  });
});
