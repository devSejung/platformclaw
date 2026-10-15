import { isBaseballRpcMethod } from "./baseball-contracts.js";
import { auditBrowserGatewayDenied } from "./browser-gateway-access.js";
import {
  BrowserGatewayProxyError,
  type BrowserGatewayAccess,
  type BrowserGatewayProxyOptions,
} from "./browser-gateway-contracts.js";
import { isKnowledgeVaultRpc } from "./browser-gateway-vault-policy.js";
import { HORSE_RACING_RPC_METHODS } from "./horse-racing-contracts.js";
import { SPACE_RPC_PARAMS } from "./space-contracts.js";

type JsonObject = Record<string, unknown>;

type PrepareBrowserSelfServiceRequestParams = {
  method: string;
  params: JsonObject;
  agentId: string;
  assertOptionalAgentId(value: unknown): void;
  assertOwnedSessionKey(value: unknown, label: string): void;
  deny(message: string): never;
};

type SkillExecutionTarget = "platform_server" | "assigned_vm";

const PASSTHROUGH_METHODS = new Set([
  "sessions.subscribe",
  "plugins.search",
  "plugins.install",
  "plugins.setEnabled",
  "plugins.uninstall",
  "skills.search",
  "skills.detail",
]);

const VM_READ_ONLY_SKILL_METHODS = new Set([
  "skills.detail",
  "skills.search",
  "skills.securityVerdicts",
  "skills.skillCard",
  "skills.status",
]);

const VM_SKILL_WORKSHOP_METHODS = new Set([
  "skills.proposals.apply",
  "skills.proposals.evaluate",
  "skills.proposals.historyScan",
  "skills.proposals.historyStatus",
  "skills.proposals.inspect",
  "skills.proposals.list",
  "skills.proposals.reject",
  "skills.proposals.requestRevision",
]);

export async function resolveBrowserExecutionTarget(
  options: Pick<BrowserGatewayProxyOptions, "store">,
  access: BrowserGatewayAccess,
  method: string,
): Promise<SkillExecutionTarget | undefined> {
  const workspaceFiles =
    method === "sessions.files.list" ||
    method === "sessions.files.upload" ||
    method === "sessions.files.download";
  if (!method.startsWith("skills.") && !workspaceFiles) {
    return undefined;
  }
  const target =
    (await options.store.getPersonalExecutionProfile(access.binding.agentId))?.activeTarget ??
    "platform_server";
  if (
    target === "assigned_vm" &&
    (method === "sessions.files.upload" || method === "sessions.files.download")
  ) {
    const action = method === "sessions.files.download" ? "download" : "upload";
    throw new BrowserGatewayProxyError(
      "method-not-allowed",
      `File ${action} is available only in the Basic workspace`,
    );
  }
  if (
    !workspaceFiles &&
    target === "assigned_vm" &&
    !VM_READ_ONLY_SKILL_METHODS.has(method) &&
    !VM_SKILL_WORKSHOP_METHODS.has(method)
  ) {
    throw new BrowserGatewayProxyError(
      "method-not-allowed",
      "Skill installation is available only in the Basic workspace",
    );
  }
  return target;
}

export async function rejectBrowserGatewayPreflight(
  options: Pick<BrowserGatewayProxyOptions, "auditWriter" | "now">,
  access: BrowserGatewayAccess,
  method: string,
  error: unknown,
): Promise<never> {
  if (error instanceof BrowserGatewayProxyError) {
    await auditBrowserGatewayDenied(options, access, method, error.code);
    throw new BrowserGatewayProxyError(error.code, error.message, "rejected-before-dispatch");
  }
  throw error;
}

export function prepareBrowserSelfServiceRequest(
  input: PrepareBrowserSelfServiceRequestParams,
): JsonObject | undefined {
  const { method, params, agentId } = input;
  if (method === "models.list") {
    if (params.view !== undefined && params.view !== "configured") {
      return input.deny("browser model catalog is limited to configured models");
    }
    return { view: "configured" };
  }
  if (method === "agents.list") {
    return {};
  }
  if (method === "users.self" || method === "plugins.list") {
    return {};
  }
  if (
    PASSTHROUGH_METHODS.has(method) ||
    isBaseballRpcMethod(method) ||
    HORSE_RACING_RPC_METHODS.some((racingMethod) => racingMethod === method) ||
    Object.hasOwn(SPACE_RPC_PARAMS, method) ||
    isKnowledgeVaultRpc(method)
  ) {
    return params;
  }
  if (method === "usage.cost" || method === "sessions.usage") {
    input.assertOptionalAgentId(params.agentId);
    if (params.key !== undefined) {
      input.assertOwnedSessionKey(params.key, "key");
    }
    const scoped: JsonObject = { ...params, agentId };
    delete scoped.agentScope;
    return scoped;
  }
  if (method === "sessions.delete") {
    input.assertOptionalAgentId(params.agentId);
    input.assertOwnedSessionKey(params.key, "key");
    return { ...params, agentId };
  }
  if (method === "skills.install") {
    input.assertOptionalAgentId(params.agentId);
    if (params.source !== "clawhub") {
      return input.deny("browser skill installation is limited to personal ClawHub skills");
    }
    return { ...params, agentId };
  }
  if (method === "skills.proposals.requestRevision") {
    input.assertOptionalAgentId(params.agentId);
    input.assertOptionalAgentId(params.targetAgentId);
    input.assertOwnedSessionKey(params.sessionKey, "sessionKey");
    return { ...params, agentId, targetAgentId: agentId };
  }
  if (VM_SKILL_WORKSHOP_METHODS.has(method)) {
    input.assertOptionalAgentId(params.agentId);
    return { ...params, agentId };
  }
  return undefined;
}
