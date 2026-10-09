import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  ErrorCodes,
  errorShape,
  type GatewayRequestHandlerOptions,
} from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
export const SPACE_AGENT_PATTERN = /^space-[a-f0-9-]{36}$/u;
export const SPACE_TOOLS = ["space_search", "space_get"];
export async function ensureSpaceAgent(
  options: GatewayRequestHandlerOptions,
  api: OpenClawPluginApi,
) {
  const params = asOptionalRecord(options.params);
  const agentId = params?.agentId;
  if (typeof agentId !== "string" || !SPACE_AGENT_PATTERN.test(agentId)) {
    options.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "Invalid Space agent"),
    );
    return;
  }
  // The managed deployment root is inferred from the trusted default workspace, never browser input.
  const base = path.dirname(
    api.runtime.agent.resolveAgentWorkspaceDir(options.context.getRuntimeConfig(), "main"),
  );
  const workspace = path.join(base, "spaces", agentId);
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  await api.runtime.config.mutateConfigFile({
    afterWrite: { mode: "auto" },
    mutate: (draft) => {
      const list = draft.agents?.list ?? [];
      const existing = list.find((agent) => agent.id === agentId);
      if (existing && path.resolve(existing.workspace ?? "") !== workspace) {
        throw new Error("Space workspace ownership mismatch");
      }
      const safe = {
        id: agentId,
        name: agentId,
        workspace,
        contextInjection: "never" as const,
        skills: [],
        memory: { search: { enabled: false } },
        tools: {
          allow: SPACE_TOOLS,
          alsoAllow: [],
          byProvider: {},
          toolsBySender: {},
          codeMode: false as const,
          elevated: { enabled: false },
        },
        sandbox: { mode: "off" as const },
        heartbeat: { every: "0m" },
      };
      // Replace only the managed entry; never inherit a person's tools, profile, or execution target.
      draft.agents = {
        ...draft.agents,
        list: [...list.filter((agent) => agent.id !== agentId), safe],
      };
    },
  });
  const live = options.context
    .getRuntimeConfig()
    .agents?.list?.find((agent) => agent.id === agentId);
  const ready =
    live?.workspace === workspace &&
    live.contextInjection === "never" &&
    live.tools?.allow?.length === SPACE_TOOLS.length &&
    SPACE_TOOLS.every((tool) => live.tools?.allow?.includes(tool));
  options.respond(true, { agentId, ready }, undefined);
}
