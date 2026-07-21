type JsonObject = Record<string, unknown>;

type ProjectionFailure = (message: string) => never;

type GatewayRequest = {
  request(method: string, params?: unknown): Promise<unknown>;
};

function asObject(value: unknown, label: string, fail: ProjectionFailure): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fail(`Gateway returned invalid ${label}`);
  }
  return value as JsonObject;
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

export async function isConfiguredBrowserModel(
  gateway: GatewayRequest,
  modelId: string,
): Promise<boolean> {
  const result = await gateway.request("models.list", { view: "configured" });
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return false;
  }
  const models = (result as JsonObject).models;
  return (
    Array.isArray(models) &&
    models.some(
      (model) =>
        Boolean(model) &&
        typeof model === "object" &&
        !Array.isArray(model) &&
        (model as JsonObject).id === modelId,
    )
  );
}
