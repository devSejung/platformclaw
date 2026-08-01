type JsonObject = Record<string, unknown>;

type ProjectionFailure = (message: string) => never;

type GatewayRequest = {
  request(method: string, params?: unknown): Promise<unknown>;
};

type BrowserSelfUser = {
  id: string;
  accountId: string;
  displayName?: string;
  email?: string;
  createdAt: number;
  updatedAt: number;
};

function asObject(value: unknown, label: string, fail: ProjectionFailure): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fail(`Gateway returned invalid ${label}`);
  }
  return value as JsonObject;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function projectBrowserSelfUser(user: BrowserSelfUser): JsonObject {
  return {
    profile: {
      id: user.id,
      displayName: user.displayName ?? user.accountId,
      avatarMime: null,
      mergedInto: null,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      emails: user.email ? [user.email] : [],
      hasAvatar: false,
    },
  };
}

function projectWorkspaceFile(value: unknown, label: string, fail: ProjectionFailure): JsonObject {
  const file = asObject(value, label, fail);
  const name = typeof file.name === "string" ? file.name.trim() : "";
  if (!name) {
    return fail("Gateway returned an invalid workspace file");
  }
  const projected: JsonObject = { name, path: name, missing: file.missing === true };
  for (const field of ["size", "updatedAtMs", "content"] as const) {
    if (file[field] !== undefined) {
      projected[field] = file[field];
    }
  }
  return projected;
}

export function projectBrowserAgentFiles(params: {
  agentId: string;
  method: string;
  result: unknown;
  fail: ProjectionFailure;
}): JsonObject {
  const payload = asObject(params.result, `${params.method} result`, params.fail);
  if (payload.agentId !== params.agentId) {
    return params.fail("Gateway returned workspace files outside the browser binding");
  }
  if (params.method === "agents.files.list") {
    if (!Array.isArray(payload.files)) {
      return params.fail("Gateway returned an invalid workspace file list");
    }
    return {
      agentId: params.agentId,
      workspace: "personal workspace",
      files: payload.files.map((file) =>
        projectWorkspaceFile(file, `${params.method} file`, params.fail),
      ),
    };
  }
  const file = projectWorkspaceFile(payload.file, `${params.method} file`, params.fail);
  return params.method === "agents.files.set"
    ? { ok: true, agentId: params.agentId, workspace: "personal workspace", file }
    : { agentId: params.agentId, workspace: "personal workspace", file };
}

export function projectBrowserSkillsStatus(params: {
  agentId: string;
  executionTarget: "platform_server" | "assigned_vm";
  result: unknown;
  fail: ProjectionFailure;
}): JsonObject {
  const payload = asObject(params.result, "skill inventory", params.fail);
  if (payload.agentId !== undefined && payload.agentId !== params.agentId) {
    return params.fail("Gateway returned skills outside the browser binding");
  }
  if (!Array.isArray(payload.skills)) {
    return params.fail("Gateway returned an invalid skill inventory");
  }
  return {
    workspaceDir: "personal workspace",
    managedSkillsDir: "managed skills",
    agentId: params.agentId,
    executionTarget: params.executionTarget,
    agentSkillFilter: payload.agentSkillFilter,
    skills: payload.skills.map((value) => {
      const skill = asObject(value, "skill inventory entry", params.fail);
      const projected = Object.assign({}, skill);
      delete projected.filePath;
      delete projected.baseDir;
      return projected;
    }),
  };
}

function projectSkillProposalRecord(
  value: unknown,
  agentId: string,
  fail: ProjectionFailure,
): JsonObject {
  const record = asObject(value, "skill proposal record", fail);
  const target = asObject(record.target, "skill proposal target", fail);
  const skillName = typeof target.skillName === "string" ? target.skillName.trim() : "";
  const skillKey = typeof target.skillKey === "string" ? target.skillKey.trim() : "";
  if (!skillName || !skillKey) {
    return fail("Gateway returned an invalid skill proposal target");
  }
  const origin = record.origin === undefined ? undefined : asObject(record.origin, "origin", fail);
  if (
    origin &&
    ((typeof origin.agentId === "string" && origin.agentId !== agentId) ||
      (typeof origin.sessionKey === "string" && !origin.sessionKey.startsWith(`agent:${agentId}:`)))
  ) {
    return fail("Gateway returned a skill proposal outside the browser binding");
  }
  const binding =
    target.binding === undefined ? undefined : asObject(target.binding, "target binding", fail);
  const targetLabel =
    binding && typeof binding.targetLabel === "string" ? binding.targetLabel : undefined;
  const projected: JsonObject = {
    ...record,
    target: { skillName, skillKey, ...(targetLabel ? { targetLabel } : {}) },
  };
  delete projected.createdBy;
  delete projected.draftFile;
  delete projected.draftHash;
  delete projected.originRunIds;
  delete projected.originRunMutationCounts;
  if (origin) {
    projected.origin = {
      ...(typeof origin.agentId === "string" ? { agentId: origin.agentId } : {}),
      ...(typeof origin.sessionKey === "string" ? { sessionKey: origin.sessionKey } : {}),
    };
  }
  return projected;
}

function projectSkillProposalManifestEntry(value: unknown, fail: ProjectionFailure): JsonObject {
  const entry = asObject(value, "skill proposal manifest entry", fail);
  const fields = [
    "id",
    "kind",
    "status",
    "title",
    "description",
    "skillName",
    "skillKey",
    "createdAt",
    "updatedAt",
    "scanState",
    "targetLabel",
  ] as const;
  const projected: JsonObject = {};
  for (const field of fields) {
    if (field === "targetLabel" && entry[field] === undefined) {
      continue;
    }
    if (typeof entry[field] !== "string") {
      return fail("Gateway returned an invalid skill proposal manifest entry");
    }
    projected[field] = entry[field];
  }
  return projected;
}

export function projectBrowserSkillProposalResult(params: {
  agentId: string;
  method: string;
  result: unknown;
  fail: ProjectionFailure;
}): unknown {
  if (params.method === "skills.proposals.list") {
    const payload = asObject(params.result, "skill proposal manifest", params.fail);
    if (
      typeof payload.schema !== "string" ||
      typeof payload.updatedAt !== "string" ||
      !Array.isArray(payload.proposals)
    ) {
      return params.fail("Gateway returned an invalid skill proposal manifest");
    }
    return {
      schema: payload.schema,
      updatedAt: payload.updatedAt,
      proposals: payload.proposals.map((entry) =>
        projectSkillProposalManifestEntry(entry, params.fail),
      ),
    };
  }
  if (params.method === "skills.proposals.inspect") {
    const payload = asObject(params.result, "skill proposal inspection", params.fail);
    const revisionHash = optionalString(payload.revisionHash);
    if (!revisionHash) {
      return params.fail("Gateway returned an invalid skill proposal revision");
    }
    return {
      record: projectSkillProposalRecord(payload.record, params.agentId, params.fail),
      revisionHash,
      content: payload.content,
      supportFiles: payload.supportFiles,
    };
  }
  if (params.method === "skills.proposals.apply") {
    const payload = asObject(params.result, "skill proposal apply result", params.fail);
    const record = projectSkillProposalRecord(payload.record, params.agentId, params.fail);
    const target = asObject(record.target, "skill proposal target", params.fail);
    const skillKey = typeof target.skillKey === "string" ? target.skillKey : "";
    if (!skillKey) {
      return params.fail("Gateway returned an invalid skill proposal target");
    }
    return { record, targetSkillFile: `${skillKey}/SKILL.md` };
  }
  if (params.method === "skills.proposals.evaluate") {
    const payload = asObject(params.result, "skill proposal evaluation result", params.fail);
    return {
      record: projectSkillProposalRecord(payload.record, params.agentId, params.fail),
      evaluation: payload.evaluation,
    };
  }
  if (params.method === "skills.proposals.reject") {
    return projectSkillProposalRecord(params.result, params.agentId, params.fail);
  }
  return params.result;
}

export function projectBrowserSkillResult(params: {
  agentId: string;
  executionTarget: "platform_server" | "assigned_vm";
  method: string;
  result: unknown;
  fail: ProjectionFailure;
}): unknown {
  if (params.method === "skills.status") {
    return projectBrowserSkillsStatus(params);
  }
  if (params.method === "skills.install") {
    const payload = asObject(params.result, "skills.install result", params.fail);
    return {
      ok: payload.ok,
      message: payload.message,
      slug: payload.slug,
      version: payload.version,
      warning: payload.warning,
    };
  }
  if (params.method === "skills.skillCard") {
    const payload = asObject(params.result, "skills.skillCard result", params.fail);
    const skillKey = optionalString(payload.skillKey);
    return skillKey
      ? { ...payload, path: `${skillKey}/SKILL.md` }
      : params.fail("Gateway returned an invalid personal skill card");
  }
  if (params.method.startsWith("skills.proposals.")) {
    if (params.method === "skills.proposals.requestRevision") {
      const payload = asObject(params.result, "skill proposal revision result", params.fail);
      const runId = optionalString(payload.runId);
      const status = optionalString(payload.status);
      return runId && status
        ? { runId, status }
        : params.fail("Gateway returned an invalid Skill Workshop revision result");
    }
    return projectBrowserSkillProposalResult(params);
  }
  return params.result;
}

export async function isConfiguredBrowserModel(
  gateway: GatewayRequest,
  modelId: string,
): Promise<boolean> {
  const result = await gateway.request("models.list", { view: "configured" });
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return false;
  }
  const models = (result as JsonObject).models;
  if (!Array.isArray(models)) {
    return false;
  }
  const selected = modelId.trim();
  return models.some((model) => {
    if (!model || typeof model !== "object" || Array.isArray(model)) {
      return false;
    }
    const entry = model as JsonObject;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const provider = typeof entry.provider === "string" ? entry.provider.trim() : "";
    if (!id) {
      return false;
    }
    if (selected === id) {
      return true;
    }
    const providerPrefix = provider ? `${provider}/` : "";
    const qualified =
      providerPrefix && !id.toLowerCase().startsWith(providerPrefix.toLowerCase())
        ? `${providerPrefix}${id}`
        : id;
    return selected === qualified;
  });
}
