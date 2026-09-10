import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MemoryPluginRuntime } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deletePersonalMemoryFile,
  parseMemoryDeleteRequest,
  registerMemoryDeleteGatewayMethod,
} from "./delete-gateway.js";

const roots: string[] = [];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
async function fixture(content = "# Personal memory\n") {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-delete-"));
  roots.push(workspaceDir);
  await fs.mkdir(path.join(workspaceDir, "memory"));
  await fs.writeFile(path.join(workspaceDir, "memory/day.md"), content);
  return { workspaceDir, path: "memory/day.md", expectedContentHash: hash(content) };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((entry) => fs.rm(entry, { recursive: true, force: true })));
});

describe("personal memory deletion", () => {
  it("removes only the confirmed full source and permits refresh retries", async () => {
    const request = await fixture();
    await fs.writeFile(path.join(request.workspaceDir, "MEMORY.md"), "Keep this");
    await deletePersonalMemoryFile(request);
    await expect(fs.readFile(path.join(request.workspaceDir, request.path))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await fs.readFile(path.join(request.workspaceDir, "MEMORY.md"), "utf8")).toBe(
      "Keep this",
    );
    await expect(deletePersonalMemoryFile(request)).resolves.toBeUndefined();
  });

  it("preserves changed and recreated source files when their hash differs", async () => {
    const request = await fixture();
    const fullPath = path.join(request.workspaceDir, request.path);
    await fs.writeFile(fullPath, "A new memory");
    await expect(deletePersonalMemoryFile(request)).rejects.toThrow("Memory changed");
    expect(await fs.readFile(fullPath, "utf8")).toBe("A new memory");
    await fs.rm(fullPath);
    await fs.writeFile(fullPath, "A recreated memory");
    await expect(deletePersonalMemoryFile(request)).rejects.toThrow("Memory changed");
  });

  it("hashes UTF-8 BOM bytes consistently with the browser preview", async () => {
    const request = await fixture("\uFEFF# 메모리\r\n");
    await expect(deletePersonalMemoryFile(request)).resolves.toBeUndefined();
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
      await expect(deletePersonalMemoryFile(request)).rejects.toThrow();
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
  ])("rejects non-memory path %s", (filePath) => {
    expect(() =>
      parseMemoryDeleteRequest({ agentId: "main", path: filePath, expectedContentHash: hash("") }),
    ).toThrow();
  });

  it("rejects missing revision and unexpected parameters", () => {
    expect(() => parseMemoryDeleteRequest({ agentId: "main", path: "MEMORY.md" })).toThrow();
    expect(() =>
      parseMemoryDeleteRequest({
        agentId: "main",
        path: "MEMORY.md",
        expectedContentHash: hash(""),
        force: true,
      }),
    ).toThrow();
  });

  it.each([true, false])(
    "reports committed deletion separately from index refresh %s",
    async (refreshSucceeds) => {
      const request = await fixture();
      let handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1] | undefined;
      const sync = refreshSucceeds
        ? vi.fn(async () => {})
        : vi.fn(async () => {
            throw new Error("offline");
          });
      const close = vi.fn(async () => {});
      const runtime = {
        getMemorySearchManager: vi.fn(async () => ({ manager: { sync, close } })),
      } as unknown as MemoryPluginRuntime;
      const api = {
        runtime: {
          config: { current: () => ({ agents: { list: [{ id: "main" }] } }) },
          agent: { resolveAgentWorkspaceDir: () => request.workspaceDir },
        },
        registerGatewayMethod: vi.fn((_name, callback) => {
          handler = callback;
        }),
      } as unknown as OpenClawPluginApi;
      registerMemoryDeleteGatewayMethod(api, runtime);
      const respond = vi.fn();
      await handler!({
        params: {
          agentId: "main",
          path: request.path,
          expectedContentHash: request.expectedContentHash,
        },
        respond,
      } as Parameters<NonNullable<typeof handler>>[0]);
      expect(respond).toHaveBeenCalledWith(true, {
        agentId: "main",
        path: request.path,
        deleted: true,
        indexesRefreshed: refreshSucceeds,
      });
      expect(sync).toHaveBeenCalledWith({ reason: "memory-delete", force: true });
      expect(close).toHaveBeenCalledOnce();
    },
  );
});
