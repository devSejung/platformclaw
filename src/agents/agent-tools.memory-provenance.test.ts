import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearMemoryPluginState,
  registerMemoryCapability,
  type MemoryFlushPlan,
} from "../plugins/memory-state.js";
import "./test-helpers/fast-bash-tools.js";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { createSandboxFsBridge } from "./sandbox/fs-bridge.js";
import { createAgentToolsSandboxContext } from "./test-helpers/agent-tools-sandbox-context.js";
import { createSandboxFsBridgeFromResolver } from "./test-helpers/host-sandbox-fs-bridge.js";

describe("sandbox file tool memory provenance", () => {
  afterEach(() => clearMemoryPluginState());

  it.each([false, true])(
    "writes and edits container paths with workspaceOnly=%s",
    async (workspaceOnly) => {
      const workspaceDir = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-provenance-")),
      );
      const recordWriteProvenance = vi.fn<NonNullable<MemoryFlushPlan["recordWriteProvenance"]>>(
        async () => {},
      );
      const clearWriteProvenance = vi.fn<NonNullable<MemoryFlushPlan["clearWriteProvenance"]>>(
        async () => {},
      );
      registerMemoryCapability("memory-core", {
        flushPlanResolver: () => ({
          softThresholdTokens: 1,
          forceFlushTranscriptBytes: 1,
          reserveTokensFloor: 1,
          prompt: "flush",
          systemPrompt: "flush",
          relativePath: "memory/note.md",
          recordWriteProvenance,
          clearWriteProvenance,
        }),
      });
      try {
        const sandbox = createAgentToolsSandboxContext({ workspaceDir });
        // Use the production mount resolver with real file IO. Container paths
        // deliberately differ from the Gateway's temporary workspace path.
        const resolver = createSandboxFsBridge({ sandbox });
        sandbox.fsBridge = createSandboxFsBridgeFromResolver((filePath, cwd) =>
          resolver.resolvePath({ filePath, cwd }),
        );
        const tools = createOpenClawCodingTools({
          workspaceDir,
          sandbox,
          config: { tools: { fs: { workspaceOnly } } },
          isTurnTainted: () => true,
        });
        const execute = async (name: string, args: unknown) => {
          const tool = tools.find((candidate) => candidate.name === name);
          if (!tool) {
            throw new Error(`Missing tool: ${name}`);
          }
          return await tool.execute(`sandbox-${name}`, args);
        };
        for (const relativePath of ["reports/new/report.txt", "memory/new/note.md"]) {
          const filePath = `/workspace/${relativePath}`;
          await execute("write", { path: filePath, content: "before\n" });
          await execute("edit", {
            path: filePath,
            edits: [{ oldText: "before", newText: "after" }],
          });
          await expect(fs.readFile(path.join(workspaceDir, relativePath), "utf8")).resolves.toBe(
            "after\n",
          );
        }
        expect(
          recordWriteProvenance.mock.calls.map(([entry]) => ({
            relativePath: entry.relativePath,
            contentBefore: entry.contentBefore,
            contentAfter: entry.contentAfter,
            originClass: entry.originClass,
          })),
        ).toEqual([
          {
            relativePath: "memory/new/note.md",
            contentBefore: "",
            contentAfter: "before\n",
            originClass: "untrusted",
          },
          {
            relativePath: "memory/new/note.md",
            contentBefore: "before\n",
            contentAfter: "after\n",
            originClass: "untrusted",
          },
        ]);
        await execute("apply_patch", {
          input:
            "*** Begin Patch\n*** Add File: /workspace/memory/new/patch.md\n+patched\n*** End Patch",
        });
        expect(recordWriteProvenance).toHaveBeenLastCalledWith(
          expect.objectContaining({
            workspaceDir,
            relativePath: "memory/new/patch.md",
            contentBefore: "",
            contentAfter: "patched\n",
            originClass: "untrusted",
          }),
        );
        await execute("apply_patch", {
          input: "*** Begin Patch\n*** Delete File: /workspace/memory/new/patch.md\n*** End Patch",
        });
        expect(clearWriteProvenance).toHaveBeenCalledWith({
          workspaceDir,
          relativePath: "memory/new/patch.md",
        });
        await expect(fs.stat(path.join(workspaceDir, "memory/new/patch.md"))).rejects.toMatchObject(
          { code: "ENOENT" },
        );
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    },
  );
});
