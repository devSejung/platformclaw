import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { withTempWorkspace } from "../../infra/private-temp-workspace.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import type { SandboxBackendHandle } from "./backend-handle.types.js";
import { registerSandboxBackend } from "./backend.js";
import { resolveSandboxContext } from "./context.js";

const mocks = vi.hoisted(() => ({
  readRegisteredSandboxRuntimeIds: vi.fn(async () => [] as string[]),
  syncSkillsToWorkspace: vi.fn(async () => []),
  updateRegistry: vi.fn(async () => undefined),
}));

vi.mock("./registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./registry.js")>()),
  readRegisteredSandboxRuntimeIds: mocks.readRegisteredSandboxRuntimeIds,
  updateRegistry: mocks.updateRegistry,
}));

vi.mock("../../skills/loading/workspace.js", () => ({
  syncSkillsToWorkspace: mocks.syncSkillsToWorkspace,
}));

function createHandle(params: { catalog: boolean; runtimeId: string }): SandboxBackendHandle {
  return {
    id: "test-skill-materialization",
    runtimeId: params.runtimeId,
    runtimeLabel: params.runtimeId,
    workdir: "/workspace",
    ...(params.catalog ? { skillCatalog: { revision: `${params.runtimeId}:1`, files: [] } } : {}),
    buildExecSpec: async () => ({ argv: [], env: {}, stdinMode: "pipe-closed" }),
    runShellCommand: async () => ({
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      code: 0,
    }),
  };
}

function createConfig(params: { backend: string; workspaceRoot: string }): OpenClawConfig {
  return {
    agents: {
      entries: { main: { default: true } },
      defaults: {
        sandbox: {
          mode: "all",
          backend: params.backend,
          workspaceAccess: "rw",
          workspaceRoot: params.workspaceRoot,
        },
      },
    },
  };
}

afterEach(() => {
  mocks.readRegisteredSandboxRuntimeIds.mockClear();
  mocks.syncSkillsToWorkspace.mockClear();
  mocks.updateRegistry.mockClear();
});

describe("sandbox backend skill materialization", () => {
  it("skips Gateway materialization when a deferred backend returns its own catalog", async () => {
    await withTempWorkspace(
      { rootDir: resolvePreferredOpenClawTmpDir(), prefix: "openclaw-backend-skills-" },
      async ({ dir }) => {
        const backendId = `test-catalog-${Date.now()}`;
        const restore = registerSandboxBackend(backendId, {
          factory: async ({ materializeSkills }) => {
            expect(materializeSkills).toEqual(expect.any(Function));
            return createHandle({ catalog: true, runtimeId: "remote-catalog" });
          },
          skillMaterialization: "backend-deferred",
        });
        try {
          const context = await resolveSandboxContext({
            config: createConfig({
              backend: backendId,
              workspaceRoot: path.join(dir, "sandboxes"),
            }),
            agentId: "main",
            sessionKey: "agent:main:main",
            workspaceDir: path.join(dir, "workspace"),
          });

          expect(context?.backend?.skillCatalog?.revision).toBe("remote-catalog:1");
          expect(mocks.syncSkillsToWorkspace).not.toHaveBeenCalled();
        } finally {
          restore();
        }
      },
    );
  });

  it("materializes Gateway skills before a deferred backend returns a local handle", async () => {
    await withTempWorkspace(
      { rootDir: resolvePreferredOpenClawTmpDir(), prefix: "openclaw-backend-skills-" },
      async ({ dir }) => {
        const backendId = `test-local-${Date.now()}`;
        const createLocalHandle = vi.fn(() =>
          createHandle({ catalog: false, runtimeId: "local-skills" }),
        );
        const factory = vi.fn(async ({ materializeSkills }) => {
          await materializeSkills?.();
          return createLocalHandle();
        });
        const restore = registerSandboxBackend(backendId, {
          factory,
          skillMaterialization: "backend-deferred",
        });
        try {
          await resolveSandboxContext({
            config: createConfig({
              backend: backendId,
              workspaceRoot: path.join(dir, "sandboxes"),
            }),
            agentId: "main",
            sessionKey: "agent:main:main",
            workspaceDir: path.join(dir, "workspace"),
          });

          expect(mocks.syncSkillsToWorkspace).toHaveBeenCalledOnce();
          expect(mocks.syncSkillsToWorkspace.mock.invocationCallOrder[0]).toBeLessThan(
            createLocalHandle.mock.invocationCallOrder[0]!,
          );
        } finally {
          restore();
        }
      },
    );
  });

  it("rejects a deferred backend that returns neither a catalog nor materialized skills", async () => {
    await withTempWorkspace(
      { rootDir: resolvePreferredOpenClawTmpDir(), prefix: "openclaw-backend-skills-" },
      async ({ dir }) => {
        const backendId = `test-invalid-${Date.now()}`;
        const restore = registerSandboxBackend(backendId, {
          factory: async () => createHandle({ catalog: false, runtimeId: "invalid" }),
          skillMaterialization: "backend-deferred",
        });
        try {
          await expect(
            resolveSandboxContext({
              config: createConfig({
                backend: backendId,
                workspaceRoot: path.join(dir, "sandboxes"),
              }),
              agentId: "main",
              sessionKey: "agent:main:main",
              workspaceDir: path.join(dir, "workspace"),
            }),
          ).rejects.toThrow("must materialize Gateway skills");
          expect(mocks.syncSkillsToWorkspace).not.toHaveBeenCalled();
        } finally {
          restore();
        }
      },
    );
  });
});
