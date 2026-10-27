import { isRecord } from "@openclaw/normalization-core/record-coerce";
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
  if (!isRecord(value)) {
    throw new BrowserGatewayProxyError("invalid-params", `${label} must be an object`);
  }
  return { ...(value as JsonObject) };
}

function invalidBrowserCatalogResult(message: string): never {
  throw new BrowserGatewayProxyError("upstream-result-denied", message);
}

function catalogResultObject(value: unknown, label: string): JsonObject {
  if (!isRecord(value)) {
    return invalidBrowserCatalogResult(`Gateway returned an invalid ${label}`);
  }
  return value;
}

function catalogResultText(value: unknown, label: string, maxChars: number): string {
  if (typeof value !== "string" || value.length > maxChars) {
    return invalidBrowserCatalogResult(`Gateway returned an invalid ${label}`);
  }
  return value;
}

function projectBrowserProviderUsage(result: unknown): JsonObject {
  const payload = catalogResultObject(result, "provider usage summary");
  if (
    typeof payload.updatedAt !== "number" ||
    !Number.isFinite(payload.updatedAt) ||
    !Array.isArray(payload.providers) ||
    payload.providers.length > 100
  ) {
    return invalidBrowserCatalogResult("Gateway returned an invalid provider usage summary");
  }
  return {
    updatedAt: payload.updatedAt,
    providers: payload.providers.map((rawProvider) => {
      const provider = catalogResultObject(rawProvider, "provider usage");
      if (!Array.isArray(provider.windows) || provider.windows.length > 32) {
        return invalidBrowserCatalogResult("Gateway returned invalid provider usage windows");
      }
      // Quota windows are useful to the employee; account identities, billing,
      // plan metadata and provider error text belong to the credential owner.
      const projected: JsonObject = {
        provider: catalogResultText(provider.provider, "usage provider", 256),
        displayName: catalogResultText(provider.displayName, "usage provider label", 256),
        windows: provider.windows.map((rawWindow) => {
          const window = catalogResultObject(rawWindow, "provider usage window");
          if (
            typeof window.usedPercent !== "number" ||
            !Number.isFinite(window.usedPercent) ||
            (window.resetAt !== undefined &&
              (typeof window.resetAt !== "number" || !Number.isFinite(window.resetAt)))
          ) {
            return invalidBrowserCatalogResult("Gateway returned an invalid provider usage window");
          }
          const projectedWindow: JsonObject = {
            label: catalogResultText(window.label, "usage window label", 256),
            usedPercent: window.usedPercent,
          };
          if (window.resetAt !== undefined) {
            projectedWindow.resetAt = window.resetAt;
          }
          return projectedWindow;
        }),
      };
      if (provider.error) {
        projected.error = "Provider usage is unavailable";
      }
      return projected;
    }),
  };
}

function projectBrowserGitHubPreview(prepared: JsonObject, result: unknown): JsonObject {
  const payload = catalogResultObject(result, "GitHub preview");
  if (
    payload.kind !== prepared.kind ||
    payload.number !== prepared.number ||
    typeof payload.owner !== "string" ||
    typeof prepared.owner !== "string" ||
    payload.owner.toLowerCase() !== prepared.owner.trim().toLowerCase() ||
    typeof payload.repo !== "string" ||
    typeof prepared.repo !== "string" ||
    payload.repo.toLowerCase() !== prepared.repo.trim().toLowerCase()
  ) {
    return invalidBrowserCatalogResult(
      "Gateway returned a different GitHub preview than requested",
    );
  }
  const projected: JsonObject = {
    kind: payload.kind,
    number: payload.number,
    owner: catalogResultText(payload.owner, "GitHub owner", 39),
    repo: catalogResultText(payload.repo, "GitHub repository", 100),
    title: catalogResultText(payload.title, "GitHub title", 4096),
    login: catalogResultText(payload.login, "GitHub author", 256),
    state: catalogResultText(payload.state, "GitHub state", 32),
    createdAt: catalogResultText(payload.createdAt, "GitHub created time", 64),
    updatedAt: catalogResultText(payload.updatedAt, "GitHub updated time", 64),
  };
  for (const field of ["closedAt", "mergedAt", "stateReason"] as const) {
    if (payload[field] !== undefined) {
      projected[field] = catalogResultText(payload[field], `GitHub ${field}`, 64);
    }
  }
  for (const field of ["additions", "changedFiles", "comments", "deletions"] as const) {
    if (typeof payload[field] === "number" && Number.isFinite(payload[field])) {
      projected[field] = payload[field];
    }
  }
  if (typeof payload.draft === "boolean") {
    projected.draft = payload.draft;
  }
  if (
    typeof payload.avatarDataUrl === "string" &&
    payload.avatarDataUrl.length <= 350_000 &&
    /^data:image\/(?:gif|jpeg|png|webp);base64,[A-Za-z0-9+/]*={0,2}$/u.test(payload.avatarDataUrl)
  ) {
    projected.avatarDataUrl = payload.avatarDataUrl;
  }
  return projected;
}

export function projectBrowserCatalogResult(params: {
  method: string;
  prepared: JsonObject;
  result: unknown;
  agentId: string;
}): { handled: false } | { handled: true; result: JsonObject } {
  if (params.method === "usage.status") {
    return { handled: true, result: projectBrowserProviderUsage(params.result) };
  }
  if (params.method === "controlUi.githubPreview") {
    return { handled: true, result: projectBrowserGitHubPreview(params.prepared, params.result) };
  }
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
