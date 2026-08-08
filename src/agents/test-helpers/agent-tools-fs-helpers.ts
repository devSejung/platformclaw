/**
 * Filesystem tool assertion helpers for tests.
 *
 * Extracts text result blocks and asserts common read/write/edit tool bundles.
 */
import { expect } from "vitest";
import {
  createSandboxedEditTool,
  createSandboxedReadTool,
  createSandboxedWriteTool,
  wrapToolWorkspaceRootGuardWithOptions,
} from "../agent-tools.read.js";
import type { SandboxContext } from "../sandbox.js";
import { SANDBOX_AGENT_WORKSPACE_MOUNT } from "../sandbox/constants.js";
import { resolveReadOnlyWorkspaceSkillMounts } from "../sandbox/workspace-mounts.js";

type TextResultBlock = { type: string; text?: string };

export function createSandboxFsTools(params: { sandbox: SandboxContext; workspaceOnly?: boolean }) {
  const tools = [
    createSandboxedReadTool({
      root: params.sandbox.workspaceDir,
      bridge: params.sandbox.fsBridge!,
    }),
    createSandboxedWriteTool({
      root: params.sandbox.workspaceDir,
      bridge: params.sandbox.fsBridge!,
    }),
    createSandboxedEditTool({
      root: params.sandbox.workspaceDir,
      bridge: params.sandbox.fsBridge!,
    }),
  ];
  if (!params.workspaceOnly) {
    return tools;
  }
  return tools.map((tool) =>
    wrapToolWorkspaceRootGuardWithOptions(tool, params.sandbox.workspaceDir, {
      additionalContainerMounts:
        tool.name === "read"
          ? [
              ...(params.sandbox.workspaceAccess === "ro"
                ? [
                    {
                      containerRoot: SANDBOX_AGENT_WORKSPACE_MOUNT,
                      hostRoot: params.sandbox.agentWorkspaceDir,
                    },
                  ]
                : []),
              ...resolveReadOnlyWorkspaceSkillMounts({
                workspaceDir: params.sandbox.workspaceDir,
                agentWorkspaceDir: params.sandbox.agentWorkspaceDir,
                skillsWorkspaceDir: params.sandbox.skillsWorkspaceDir,
                workdir: params.sandbox.containerWorkdir,
                workspaceAccess: params.sandbox.workspaceAccess,
              }).map((mount) => ({
                containerRoot: mount.containerPath,
                hostRoot: mount.hostPath,
              })),
            ]
          : undefined,
      containerWorkdir: params.sandbox.containerWorkdir,
    }),
  );
}

/** Extracts the first text block from a tool result. */
export function getTextContent(result?: { content?: TextResultBlock[] }) {
  const textBlock = result?.content?.find((block) => block.type === "text");
  return textBlock?.text ?? "";
}

function expectTool<T extends { name: string }>(tools: T[], name: string): T {
  const tool = tools.find((entry) => entry.name === name);
  if (!tool) {
    throw new Error(`expected tool "${name}" in [${tools.map((entry) => entry.name).join(", ")}]`);
  }
  return tool;
}

/** Asserts read/write/edit tools are present and returns them by name. */
export function expectReadWriteEditTools<T extends { name: string }>(tools: T[]) {
  const names = tools.map((tool) => tool.name);
  expect(names).toContain("read");
  expect(names).toContain("write");
  expect(names).toContain("edit");
  return {
    readTool: expectTool(tools, "read"),
    writeTool: expectTool(tools, "write"),
    editTool: expectTool(tools, "edit"),
  };
}

/** Asserts read/write tools are present and returns them by name. */
export function expectReadWriteTools<T extends { name: string }>(tools: T[]) {
  const names = tools.map((tool) => tool.name);
  expect(names).toContain("read");
  expect(names).toContain("write");
  return {
    readTool: expectTool(tools, "read"),
    writeTool: expectTool(tools, "write"),
  };
}
