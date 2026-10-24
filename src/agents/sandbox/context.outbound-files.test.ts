// Verify the prepared attachment reader, shell environment, and policy guidance together.
import { expect, it, vi } from "vitest";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { SandboxBackendCommandParams, SandboxBackendHandle } from "./backend-handle.types.js";
import { registerSandboxBackend } from "./backend.js";
import { resolveSandboxContext } from "./context.js";

it.each([false, true])(
  "prepares outbound capability with workspaceOnly=%s",
  async (workspaceOnly) => {
    const buildExecSpec = vi.fn<SandboxBackendHandle["buildExecSpec"]>(async () => ({
      argv: ["test-backend", "exec"],
      env: {},
      stdinMode: "pipe-closed",
    }));
    const runShellCommand = vi.fn(async ({ args }: SandboxBackendCommandParams) => ({
      stdout: Buffer.from(`/tmp/openclaw-1000-${args?.[1]}`),
      stderr: Buffer.alloc(0),
      code: 0,
    }));
    const state = await createOpenClawTestState({
      layout: "state-only",
      prefix: "outbound-context-",
    });
    const restore = registerSandboxBackend("test-outbound-backend", {
      skillMaterialization: "backend-deferred",
      factory: async () => ({
        id: "test-outbound-backend",
        runtimeId: "outbound-runtime",
        runtimeLabel: "Outbound Runtime",
        workdir: "/runtime/workspace",
        capabilities: { outboundFiles: true },
        env: { KEEP: "value" },
        runtimePromptContext: "current target facts",
        skillCatalog: { revision: "fixture", files: [] },
        buildExecSpec,
        runShellCommand,
      }),
    });
    try {
      const workspaceDir = state.workspaceDir;
      const result = await resolveSandboxContext({
        config: {
          tools: { fs: { workspaceOnly } },
          agents: {
            defaults: {
              sandbox: {
                mode: "all",
                backend: "test-outbound-backend",
                workspaceAccess: "rw",
                prune: { idleHours: 0, maxAgeDays: 0 },
              },
            },
          },
        },
        sessionKey: "agent:worker:main",
        workspaceDir,
      });
      const tempDir = result?.outboundFileAccess?.tempDir;
      expect(tempDir).toMatch(/^\/tmp\/openclaw-1000-[0-9a-f]{64}$/u);
      expect(result?.backend?.env).toEqual({ KEEP: "value", TMPDIR: tempDir });
      expect(result?.backend?.runtimePromptContext).toContain(`target: ${tempDir}.`);
      expect(result?.backend?.runtimePromptContext).toContain("current target facts");
      if (workspaceOnly) {
        expect(result?.backend?.runtimePromptContext).toContain(
          "Filesystem policy restricts file tools and attachments to /runtime/workspace.",
        );
        expect(result?.backend?.runtimePromptContext).not.toContain(
          "Ordinary file tools also support your own /tmp files",
        );
        await expect(
          result?.outboundFileAccess?.readFile({
            filePath: `${tempDir}/report.txt`,
            maxBytes: 100,
          }),
        ).rejects.toThrow();
      } else {
        expect(result?.backend?.runtimePromptContext).toContain(
          "Ordinary file tools also support your own /tmp files",
        );
      }
      await result?.backend?.buildExecSpec({
        command: "true",
        usePty: false,
        env: { OTHER: "value", TMPDIR: "/wrong-target" },
      });
      expect(buildExecSpec).toHaveBeenCalledWith(
        expect.objectContaining({ env: { OTHER: "value", TMPDIR: tempDir } }),
      );
      expect(runShellCommand).toHaveBeenCalledOnce();
    } finally {
      restore();
      await state.cleanup();
    }
  },
  15_000,
);
