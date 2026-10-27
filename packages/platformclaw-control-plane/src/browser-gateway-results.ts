import type { BrowserGatewayAssertions } from "./browser-gateway-assertions.js";
import { projectBrowserCatalogResult } from "./browser-gateway-catalog-projections.js";
import {
  asBrowserGatewayObject as asObject,
  BrowserGatewayProxyError,
  type BrowserGatewayAccess,
} from "./browser-gateway-contracts.js";
import { projectCronResult, type BrowserCronContext } from "./browser-gateway-cron-controller.js";
import type { BrowserGatewayLiveCapabilities } from "./browser-gateway-live-capabilities.js";
import { projectBrowserPersonalReadResult } from "./browser-gateway-personal-reads.js";
import { projectBrowserAgentSummary } from "./browser-gateway-projections.js";
import {
  projectBrowserAgentFiles,
  projectBrowserSkillResult,
} from "./browser-gateway-self-service-projections.js";
import { projectBrowserSessionResult } from "./browser-gateway-session-projections.js";
import type { BrowserGatewaySpaceAccess } from "./browser-gateway-space-access.js";
import { isBrowserTaskMethod, projectBrowserTaskResult } from "./browser-gateway-task-policy.js";
import { scopeBrowserMediaDownloadUrl } from "./browser-media-url.js";

type JsonObject = Record<string, unknown>;

/** Projects private Gateway responses through the personal browser boundary. */
export function projectBrowserGatewayResult(params: {
  access: BrowserGatewayAccess;
  method: string;
  prepared: JsonObject;
  result: unknown;
  executionTarget?: "platform_server" | "assigned_vm";
  assertions: BrowserGatewayAssertions;
  liveCapabilities: BrowserGatewayLiveCapabilities;
  cronContext: BrowserCronContext;
  spaceAccess: BrowserGatewaySpaceAccess;
}): unknown {
  const { access, method, prepared, result, executionTarget } = params;
  const fail = (message: string): never => {
    throw new BrowserGatewayProxyError("upstream-result-denied", message);
  };
  if (method.startsWith("cron.")) {
    return projectCronResult(params.cronContext, method, result);
  }
  const liveResult = params.liveCapabilities.projectResult(access.binding.agentId, method, result);
  if (liveResult.handled) {
    return liveResult.result;
  }
  const sessionResult = projectBrowserSessionResult({
    method,
    prepared,
    result,
    canAccessWorkspaceFiles: (write) =>
      executionTarget === "platform_server" &&
      typeof prepared.sessionKey === "string" &&
      params.spaceAccess.allowsAgentSession(access.binding.agentId, prepared.sessionKey, write),
    assertOwnedResultSessionKey: (value) =>
      params.assertions.ownedResultSessionKey(access.binding.agentId, value),
    scopeDownloadUrl: (value) => scopeBrowserMediaDownloadUrl(value, access),
    projectSessionPayloadForAccess: (value) =>
      params.spaceAccess.projectSessionPayload(access, value, method === "sessions.list"),
    fail,
  });
  if (sessionResult !== undefined) {
    return sessionResult;
  }
  if (isBrowserTaskMethod(method)) {
    return projectBrowserTaskResult({
      access: params.spaceAccess.taskAccess(access),
      method,
      ...(method === "tasks.retry" || method === "tasks.dismiss"
        ? { requestedTaskIds: new Set(prepared.taskIds as string[]) }
        : {}),
      result,
      fail,
    });
  }
  const personalReadResult = projectBrowserPersonalReadResult({
    method,
    request: prepared,
    result,
    agentId: access.binding.agentId,
    fail,
  });
  if (personalReadResult !== undefined) {
    return personalReadResult;
  }
  if (method.startsWith("agents.files.")) {
    return projectBrowserAgentFiles({
      agentId: access.binding.agentId,
      method,
      result,
      fail,
    });
  }
  if (method.startsWith("skills.")) {
    return projectBrowserSkillResult({
      agentId: access.binding.agentId,
      executionTarget: executionTarget ?? "platform_server",
      method,
      result,
      fail,
    });
  }
  const catalogResult = projectBrowserCatalogResult({
    method,
    prepared,
    result,
    agentId: access.binding.agentId,
  });
  if (catalogResult.handled) {
    return catalogResult.result;
  }
  if (method === "chat.history" || method === "chat.startup") {
    const payload = asObject(result, `${method} result`);
    if (payload.sessionKey !== undefined) {
      params.assertions.ownedResultSessionKey(access.binding.agentId, payload.sessionKey);
    }
    const sessionInfo =
      payload.sessionInfo === undefined
        ? undefined
        : params.spaceAccess.projectSessionPayload(access, payload.sessionInfo);
    if (sessionInfo === null) {
      throw new BrowserGatewayProxyError(
        "upstream-result-denied",
        "Gateway returned session metadata outside the browser binding",
      );
    }
    const projectedPayload = sessionInfo ? { ...payload, sessionInfo } : payload;
    if (method === "chat.history") {
      return projectedPayload;
    }
    const agentsList = asObject(projectedPayload.agentsList, "chat.startup agentsList");
    const agents = Array.isArray(agentsList.agents)
      ? agentsList.agents
          .map(projectBrowserAgentSummary)
          .filter((entry) => entry?.id === access.binding.agentId)
      : [];
    if (agents.length !== 1) {
      throw new BrowserGatewayProxyError(
        "upstream-result-denied",
        "owned agent missing from Gateway startup response",
      );
    }
    return {
      ...projectedPayload,
      agentsList: { ...agentsList, defaultId: access.binding.agentId, agents },
    };
  }
  if (method === "chat.message.get") {
    params.assertions.ownedResultSessionKey(access.binding.agentId, prepared.sessionKey);
    const payload = asObject(result, "chat.message.get result");
    if (payload.ok === true) {
      if (payload.message === undefined) {
        throw new BrowserGatewayProxyError(
          "upstream-result-denied",
          "Gateway returned an invalid direct message result",
        );
      }
      return { ok: true, message: payload.message };
    }
    return payload.unavailableReason === undefined
      ? { ok: false }
      : { ok: false, unavailableReason: payload.unavailableReason };
  }
  if (method === "sessions.search") {
    return params.spaceAccess.projectSessionSearch(access, prepared, result);
  }
  if (method === "sessions.preview") {
    const payload = asObject(result, "sessions.preview result");
    const previews = Array.isArray(payload.previews) ? payload.previews : [];
    if (previews.some((entry) => !params.spaceAccess.payloadBelongsToAccess(access, entry))) {
      throw new BrowserGatewayProxyError(
        "upstream-result-denied",
        "Gateway returned a preview outside the browser binding",
      );
    }
    return payload;
  }
  if (method === "sessions.create" || method === "sessions.resolve") {
    const payload = asObject(result, `${method} result`);
    if (payload.ok === false) {
      return { ok: false };
    }
    params.assertions.ownedResultSessionKey(access.binding.agentId, payload.key);
    return { ok: true, key: payload.key };
  }
  return result;
}
