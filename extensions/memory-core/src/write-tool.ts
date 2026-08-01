import path from "node:path";
import {
  asToolParamsRecord,
  jsonResult,
  readStringParam,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { appendRegularFile } from "openclaw/plugin-sdk/security-runtime";

const MAX_MEMORY_FILE_BYTES = 2 * 1024 * 1024;

export function createMemoryWriteTool(params: { workspaceDir: string }): AnyAgentTool {
  return {
    label: "Memory Write",
    name: "memory_write",
    description: "Append durable Agent memory.",
    parameters: {
      type: "object",
      properties: { content: { type: "string", minLength: 1, maxLength: 20000 } },
      required: ["content"],
      additionalProperties: false,
    },
    execute: async (_toolCallId, raw) => {
      const content = readStringParam(asToolParamsRecord(raw), "content", {
        required: true,
      });
      if (content.length > 20_000) {
        throw new Error("memory content exceeds 20000 characters");
      }
      const filePath = path.join(params.workspaceDir, "MEMORY.md");
      await appendRegularFile({
        filePath,
        content: `\n${content}\n`,
        maxFileBytes: MAX_MEMORY_FILE_BYTES,
        rejectSymlinkParents: true,
      });
      return jsonResult({ saved: true, path: "MEMORY.md" });
    },
  };
}
