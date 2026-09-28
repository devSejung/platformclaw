import type { MemoryCitationsMode } from "../config/types.memory.js";
import {
  prepareMemoryPromptSection,
  type PreparedMemoryPromptSection,
} from "../plugins/memory-state.js";

/** Prepare memory prompt state with the same normalized tool context used by assembly. */
export async function prepareAgentMemoryPrompt(params: {
  runId?: string;
  enabled: boolean;
  toolNames: Iterable<string>;
  capabilityToolNames?: Iterable<string>;
  citationsMode?: MemoryCitationsMode;
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
}): Promise<PreparedMemoryPromptSection | undefined> {
  if (!params.enabled) {
    return undefined;
  }
  const availableTools = new Set(
    [...params.toolNames, ...(params.capabilityToolNames ?? [])]
      .map((tool) => tool.trim().toLowerCase())
      .filter(Boolean),
  );
  return prepareMemoryPromptSection({
    runId: params.runId,
    availableTools,
    citationsMode: params.citationsMode,
    agentId: params.agentId,
    agentSessionKey: params.agentSessionKey,
    sandboxed: params.sandboxed,
  });
}
