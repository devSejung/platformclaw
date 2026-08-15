import { projectBrowserCommands } from "./browser-command-policy.js";
import { BrowserGatewayProxyError } from "./browser-gateway-contracts.js";
import {
  projectBrowserAgentSummary,
  projectBrowserModelChoice,
} from "./browser-gateway-projections.js";

type JsonObject = Record<string, unknown>;

function asObject(value: unknown, label: string): JsonObject {
  if (value === undefined) {
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BrowserGatewayProxyError("invalid-params", `${label} must be an object`);
  }
  return { ...(value as JsonObject) };
}

export function projectBrowserCatalogResult(params: {
  method: string;
  result: unknown;
  agentId: string;
}): { handled: false } | { handled: true; result: JsonObject } {
  if (params.method === "models.list") {
    const payload = asObject(params.result, "models.list result");
    const models = Array.isArray(payload.models)
      ? payload.models.map(projectBrowserModelChoice).filter((entry) => entry !== null)
      : [];
    return { handled: true, result: { models } };
  }
  if (params.method === "chat.metadata" || params.method === "commands.list") {
    const payload = asObject(params.result, `${params.method} result`);
    const commands = projectBrowserCommands(payload.commands);
    return {
      handled: true,
      result:
        params.method === "chat.metadata" && payload.models !== undefined
          ? { models: payload.models, commands }
          : { commands },
    };
  }
  if (params.method !== "agents.list") {
    return { handled: false };
  }
  const payload = asObject(params.result, "agents.list result");
  const agents = Array.isArray(payload.agents)
    ? payload.agents.map(projectBrowserAgentSummary).filter((entry) => entry?.id === params.agentId)
    : [];
  if (agents.length !== 1) {
    throw new BrowserGatewayProxyError(
      "upstream-result-denied",
      "owned agent missing from Gateway response",
    );
  }
  return {
    handled: true,
    result: { ...payload, defaultId: params.agentId, agents },
  };
}
