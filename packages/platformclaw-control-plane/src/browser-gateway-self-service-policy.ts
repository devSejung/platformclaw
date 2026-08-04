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

export async function resolveBrowserSkillExecutionTarget(input: {
  method: string;
  load(): Promise<{ activeTarget: SkillExecutionTarget } | null | undefined>;
  deny(message: string): never;
}): Promise<SkillExecutionTarget | undefined> {
  if (!input.method.startsWith("skills.")) {
    return undefined;
  }
  const target = (await input.load())?.activeTarget ?? "platform_server";
  if (
    target === "assigned_vm" &&
    !VM_READ_ONLY_SKILL_METHODS.has(input.method) &&
    !VM_SKILL_WORKSHOP_METHODS.has(input.method)
  ) {
    return input.deny("Skill installation is available only in the Basic workspace");
  }
  return target;
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
  if (PASSTHROUGH_METHODS.has(method)) {
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
