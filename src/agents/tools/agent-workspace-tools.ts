import { Type } from "typebox";
import { readFileWithinRoot, writeFileWithinRoot } from "../../infra/fs-safe.js";
import { stringEnum } from "../schema/typebox.js";
import {
  completeWorkspaceBootstrap,
  DEFAULT_BOOTSTRAP_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_USER_FILENAME,
} from "../workspace.js";
import {
  type AnyAgentTool,
  ToolInputError,
  asToolParamsRecord,
  readStringParam,
  textResult,
} from "./common.js";

export const AGENT_WORKSPACE_TOOL_NAMES = [
  "agent_workspace_read",
  "agent_workspace_write",
  "agent_workspace_edit",
  "bootstrap_complete",
] as const;

const AGENT_WORKSPACE_FILES = [
  DEFAULT_SOUL_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_USER_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
] as const;

const FileSchema = stringEnum(AGENT_WORKSPACE_FILES, {
  description: "Exact Agent-owned file in the canonical Gateway workspace.",
});
const ReadSchema = Type.Object({ file: FileSchema }, { additionalProperties: false });
const WriteSchema = Type.Object(
  { file: FileSchema, content: Type.String() },
  { additionalProperties: false },
);
const EditSchema = Type.Object(
  {
    file: FileSchema,
    old_text: Type.String({ minLength: 1 }),
    new_text: Type.String(),
  },
  { additionalProperties: false },
);
const CompleteSchema = Type.Object({}, { additionalProperties: false });

function readFileName(params: Record<string, unknown>): (typeof AGENT_WORKSPACE_FILES)[number] {
  const value = readStringParam(params, "file", { required: true });
  if (!AGENT_WORKSPACE_FILES.includes(value as (typeof AGENT_WORKSPACE_FILES)[number])) {
    throw new ToolInputError(`file must be one of: ${AGENT_WORKSPACE_FILES.join(", ")}`);
  }
  return value as (typeof AGENT_WORKSPACE_FILES)[number];
}

async function readAgentFile(workspaceDir: string, file: string): Promise<string> {
  const result = await readFileWithinRoot({
    rootDir: workspaceDir,
    relativePath: file,
    maxBytes: 256 * 1024,
  });
  return result.buffer.toString("utf8");
}

export function createAgentWorkspaceTools(workspaceDir: string): AnyAgentTool[] {
  return [
    {
      label: "Read Agent File",
      name: "agent_workspace_read",
      description:
        "Read one Agent-owned profile or bootstrap file from the canonical Agent workspace. General read accesses the active project instead.",
      parameters: ReadSchema,
      execute: async (_id, raw) => {
        const file = readFileName(asToolParamsRecord(raw));
        return textResult(await readAgentFile(workspaceDir, file), { file });
      },
    },
    {
      label: "Write Agent File",
      name: "agent_workspace_write",
      description:
        "Replace one Agent-owned profile or bootstrap file in the canonical Agent workspace. Cannot write project files or arbitrary paths.",
      parameters: WriteSchema,
      execute: async (_id, raw) => {
        const params = asToolParamsRecord(raw);
        const file = readFileName(params);
        const content = readStringParam(params, "content", { required: true, trim: false });
        await writeFileWithinRoot({ rootDir: workspaceDir, relativePath: file, data: content });
        return textResult(`Updated ${file}`, { file, changed: true });
      },
    },
    {
      label: "Edit Agent File",
      name: "agent_workspace_edit",
      description:
        "Replace one exact, unique text occurrence in an Agent-owned profile or bootstrap file. Cannot edit project files or arbitrary paths.",
      parameters: EditSchema,
      execute: async (_id, raw) => {
        const params = asToolParamsRecord(raw);
        const file = readFileName(params);
        const oldText = readStringParam(params, "old_text", { required: true, trim: false });
        const newText = readStringParam(params, "new_text", { required: true, trim: false });
        const content = await readAgentFile(workspaceDir, file);
        const first = content.indexOf(oldText);
        if (first < 0) {
          throw new ToolInputError("old_text was not found");
        }
        if (content.indexOf(oldText, first + oldText.length) >= 0) {
          throw new ToolInputError("old_text must match exactly once");
        }
        const updated = `${content.slice(0, first)}${newText}${content.slice(first + oldText.length)}`;
        await writeFileWithinRoot({ rootDir: workspaceDir, relativePath: file, data: updated });
        return textResult(`Updated ${file}`, { file, changed: updated !== content });
      },
    },
    {
      label: "Complete Bootstrap",
      name: "bootstrap_complete",
      description:
        "Mark Agent bootstrap complete in canonical Gateway state and remove its BOOTSTRAP.md. Call only after the Agent profile is ready.",
      parameters: CompleteSchema,
      execute: async () => {
        const state = await completeWorkspaceBootstrap(workspaceDir);
        return textResult("Bootstrap completed", {
          completed: true,
          setupCompletedAt: state.setupCompletedAt,
        });
      },
    },
  ];
}
