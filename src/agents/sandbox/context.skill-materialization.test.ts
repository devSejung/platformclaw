import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { withTempWorkspace } from "../../infra/private-temp-workspace.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import type { SandboxBackendHandle } from "./backend-handle.types.js";
import { registerSandboxBackend } from "./backend.js";
import type { CreateSandboxBackendParams } from "./backend.types.js";
import { resolveSandboxContext } from "./context.js";

const mocks = vi.hoisted(() => ({
  logInfo: vi.fn(),
  readRegisteredSandboxRuntimeIds: vi.fn(async () => [] as string[]),
  syncSkillsToWorkspace: vi.fn(async () => []),
  updateRegistry: vi.fn(async () => undefined),
}));

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    debug: vi.fn(),
    info: mocks.logInfo,
    warn: vi.fn(),
    error: vi.fn(),
  }),
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
  mocks.logInfo.mockClear();
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
          const timingLine = mocks.logInfo.mock.calls
            .map(([message]) => String(message))
            .find((message) => message.includes("event=sandbox_context_timing"));
          expect(timingLine).toContain("deferredSkills=true");
          expect(timingLine).toContain("skillsMaterialized=false");
          expect(timingLine).toContain("backendInclusiveMs=");
          expect(timingLine).toContain("totalMs=");
          expect(timingLine).not.toContain(dir);
          expect(timingLine).not.toContain("agent:main:main");
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

  it("keeps a deferred backend's global skill paths canonical and read-only mountable", async () => {
    await withTempWorkspace(
      { rootDir: resolvePreferredOpenClawTmpDir(), prefix: "openclaw-canonical-skills-" },
      async ({ dir }) => {
        mocks.syncSkillsToWorkspace.mockImplementationOnce(async ({ targetWorkspaceDir }) => {
          const readPath = path.join(targetWorkspaceDir, "skills", "confluence-read", "SKILL.md");
          await fs.mkdir(path.dirname(readPath), { recursive: true });
          await fs.writeFile(
            readPath,
            "---\nname: confluence-read\ndescription: Read Confluence\n---\nUse .env.atlassian\n",
          );
          await fs.writeFile(path.join(path.dirname(readPath), ".env.atlassian"), "TOKEN=test\n");
          return [
            {
              readPath,
              skillFile: path.join(dir, "managed", "confluence-read", "SKILL.md"),
              skillName: "confluence-read",
              skillSource: "workspace" as const,
              skillSourceId: "openclaw-managed",
            },
          ];
        });
        const backendId = `test-canonical-${Date.now()}`;
        let materialized: Awaited<
          ReturnType<NonNullable<CreateSandboxBackendParams["materializeSkills"]>>
        > | null = null;
        const restore = registerSandboxBackend(backendId, {
          factory: async ({ materializeSkills }) => {
            materialized =
              (await materializeSkills?.({
                sourceMounts: [
                  { source: "openclaw-managed", containerPath: "/opt/platformclaw/skills" },
                ],
              })) ?? null;
            return {
              ...createHandle({ catalog: false, runtimeId: "canonical-skills" }),
              ...(materialized ? { skillCatalog: materialized.catalog } : {}),
            };
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

          expect(materialized?.catalog.files).toEqual([
            expect.objectContaining({
              filePath: "/opt/platformclaw/skills/confluence-read/SKILL.md",
              source: "openclaw-managed",
            }),
          ]);
          expect(context?.skillUsagePaths?.[0]?.readPath).toBe(
            "/opt/platformclaw/skills/confluence-read/SKILL.md",
          );
          expect(materialized?.mounts).toEqual([
            expect.objectContaining({ containerPath: "/opt/platformclaw/skills" }),
          ]);
          const hostRoot = materialized!.mounts[0]!.hostPath;
          await expect(
            fs.readFile(path.join(hostRoot, "confluence-read", ".env.atlassian"), "utf8"),
          ).resolves.toBe("TOKEN=test\n");
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
