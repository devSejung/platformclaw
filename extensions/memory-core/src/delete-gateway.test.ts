import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ErrorCodes, type GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import type { MemoryPluginRuntime } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerMemoryDeleteGatewayMethod } from "./delete-gateway.js";

const roots: string[] = [];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
async function fixture(content = "# Personal memory\n") {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-delete-"));
  roots.push(workspaceDir);
  await fs.mkdir(path.join(workspaceDir, "memory"));
  await fs.writeFile(path.join(workspaceDir, "memory/day.md"), content);
  return { workspaceDir, path: "memory/day.md", expectedContentHash: hash(content) };
}

function gateway(workspaceDir = "", refreshSucceeds = true) {
  let handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1] | undefined;
  const config = { agents: { list: [{ id: "main" }] } };
  const getRuntimeConfig = vi
    .fn<GatewayRequestHandlerOptions["context"]["getRuntimeConfig"]>()
    .mockReturnValueOnce(config)
    .mockReturnValue({ agents: { list: [] } });
  const sync = vi.fn(async () => {
    if (!refreshSucceeds) {
      throw new Error("offline");
    }
  });
  const close = vi.fn(async () => {});
  const getMemorySearchManager = vi.fn(async () => ({ manager: { sync, close } }));
  const resolveAgentWorkspaceDir = vi.fn(() => workspaceDir);
  const api = {
    runtime: { agent: { resolveAgentWorkspaceDir } },
    registerGatewayMethod: vi.fn((_name, callback) => {
      handler = callback;
    }),
  } as unknown as OpenClawPluginApi;
  registerMemoryDeleteGatewayMethod(api, {
    getMemorySearchManager,
  } as unknown as MemoryPluginRuntime);
  expect(api.registerGatewayMethod).toHaveBeenCalledWith("memory.delete", expect.any(Function), {
    scope: "operator.write",
  });
  return {
    config,
    getRuntimeConfig,
    sync,
    close,
    getMemorySearchManager,
    resolveAgentWorkspaceDir,
    async invoke(params: Record<string, unknown>) {
      if (!handler) {
        throw new Error("memory.delete was not registered");
      }
      const respond = vi.fn();
      const context: Pick<GatewayRequestHandlerOptions["context"], "getRuntimeConfig"> = {
        getRuntimeConfig,
      };
      await handler({
        req: { type: "req", id: "memory-delete-test", method: "memory.delete", params },
        params,
        client: null,
        isWebchatConnect: () => false,
        respond,
        context: context as GatewayRequestHandlerOptions["context"],
      });
      return respond;
    },
  };
}

async function requestThroughGateway(params: Record<string, unknown>, workspaceDir = "") {
  const respond = await gateway(workspaceDir).invoke(params);
  expect(respond).toHaveBeenCalledOnce();
  const [ok, , error] = respond.mock.calls[0]!;
  if (!ok) {
    throw Object.assign(new Error(error.message), { code: error.code });
  }
}

async function deleteThroughGateway(request: {
  workspaceDir: string;
  path: string;
  expectedContentHash: string;
}) {
  await requestThroughGateway(
    { agentId: "main", path: request.path, expectedContentHash: request.expectedContentHash },
    request.workspaceDir,
  );
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((entry) => fs.rm(entry, { recursive: true, force: true })));
});

describe("personal memory deletion", () => {
  it("removes only the confirmed full source and permits refresh retries", async () => {
    const request = await fixture();
    await fs.writeFile(path.join(request.workspaceDir, "MEMORY.md"), "Keep this");
    await deleteThroughGateway(request);
    await expect(fs.readFile(path.join(request.workspaceDir, request.path))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await fs.readFile(path.join(request.workspaceDir, "MEMORY.md"), "utf8")).toBe(
      "Keep this",
    );
    await expect(deleteThroughGateway(request)).resolves.toBeUndefined();
  });

  it("preserves changed and recreated source files when their hash differs", async () => {
    const request = await fixture();
    const fullPath = path.join(request.workspaceDir, request.path);
    await fs.writeFile(fullPath, "A new memory");
    await expect(deleteThroughGateway(request)).rejects.toThrow("Memory changed");
    expect(await fs.readFile(fullPath, "utf8")).toBe("A new memory");
    await fs.rm(fullPath);
    await fs.writeFile(fullPath, "A recreated memory");
    await expect(deleteThroughGateway(request)).rejects.toThrow("Memory changed");
  });

  it("hashes UTF-8 BOM bytes consistently with the browser preview", async () => {
    const request = await fixture("\uFEFF# 메모리\r\n");
    await expect(deleteThroughGateway(request)).resolves.toBeUndefined();
  });

  it.runIf(process.platform !== "win32")(
    "rejects a symlink source and preserves its target",
    async () => {
      const request = await fixture();
      const fullPath = path.join(request.workspaceDir, request.path);
      const target = path.join(request.workspaceDir, "outside.md");
      await fs.writeFile(target, "# Personal memory\n");
      await fs.rm(fullPath);
      await fs.symlink(target, fullPath);
      await expect(deleteThroughGateway(request)).rejects.toThrow();
      expect(await fs.readFile(target, "utf8")).toBe("# Personal memory\n");
    },
  );

  it.each([
    "../MEMORY.md",
    "memory/../AGENTS.md",
    "memory/./day.md",
    "memory//day.md",
    "memory\\day.md",
    "memory/day.md:stream",
    "AGENTS.md",
    "/memory/day.md",
    "memory/data.json",
    ...[0, 9, 10, 31].map((code) => `memory/a${String.fromCharCode(code)}.md`),
  ])("rejects non-memory path %s", async (filePath) => {
    await expect(
      requestThroughGateway({ agentId: "main", path: filePath, expectedContentHash: hash("") }),
    ).rejects.toMatchObject({ code: ErrorCodes.INVALID_REQUEST });
  });

  it("rejects missing revision and unexpected parameters", async () => {
    await expect(
      requestThroughGateway({ agentId: "main", path: "MEMORY.md" }),
    ).rejects.toMatchObject({ code: ErrorCodes.INVALID_REQUEST });
    await expect(
      requestThroughGateway({
        agentId: "main",
        path: "MEMORY.md",
        expectedContentHash: hash(""),
        force: true,
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.INVALID_REQUEST });
  });

  it.each([true, false])(
    "reports committed deletion separately from index refresh %s",
    async (refreshSucceeds) => {
      const request = await fixture();
      const route = gateway(request.workspaceDir, refreshSucceeds);
      const respond = await route.invoke({
        agentId: "main",
        path: request.path,
        expectedContentHash: request.expectedContentHash,
      });
      expect(respond).toHaveBeenCalledWith(true, {
        agentId: "main",
        path: request.path,
        deleted: true,
        indexesRefreshed: refreshSucceeds,
      });
      expect(route.sync).toHaveBeenCalledWith({ reason: "memory-delete", force: true });
      expect(route.close).toHaveBeenCalledOnce();
      expect(route.getRuntimeConfig).toHaveBeenCalledOnce();
      expect(route.resolveAgentWorkspaceDir).toHaveBeenCalledWith(route.config, "main");
      expect(route.getMemorySearchManager).toHaveBeenCalledWith({
        cfg: route.config,
        agentId: "main",
        purpose: "cli",
      });
    },
  );
});
