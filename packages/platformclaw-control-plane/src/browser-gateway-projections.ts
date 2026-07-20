type JsonObject = Record<string, unknown>;

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function projectBrowserAgentSummary(value: unknown): JsonObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const source = value as JsonObject;
  const id = optionalString(source.id);
  if (!id) {
    return null;
  }
  const projected: JsonObject = { id };
  const name = optionalString(source.name);
  if (name) {
    projected.name = name;
  }
  if (source.identity && typeof source.identity === "object" && !Array.isArray(source.identity)) {
    const identitySource = source.identity as JsonObject;
    const identity: JsonObject = {};
    for (const key of ["name", "theme", "emoji", "avatarUrl"]) {
      const field = optionalString(identitySource[key]);
      if (field) {
        identity[key] = field;
      }
    }
    if (Object.keys(identity).length > 0) {
      projected.identity = identity;
    }
  }
  if (source.model && typeof source.model === "object" && !Array.isArray(source.model)) {
    const modelSource = source.model as JsonObject;
    const primary = optionalString(modelSource.primary);
    const fallbacks = Array.isArray(modelSource.fallbacks)
      ? modelSource.fallbacks.map(optionalString).filter((entry) => entry !== undefined)
      : undefined;
    if (primary || fallbacks) {
      projected.model = { ...(primary ? { primary } : {}), ...(fallbacks ? { fallbacks } : {}) };
    }
  }
  if (Array.isArray(source.thinkingLevels)) {
    projected.thinkingLevels = source.thinkingLevels.flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return [];
      }
      const level = entry as JsonObject;
      const levelId = optionalString(level.id);
      const label = optionalString(level.label);
      return levelId && label ? [{ id: levelId, label }] : [];
    });
  }
  if (Array.isArray(source.thinkingOptions)) {
    projected.thinkingOptions = source.thinkingOptions
      .map(optionalString)
      .filter((entry) => entry !== undefined);
  }
  const thinkingDefault = optionalString(source.thinkingDefault);
  if (thinkingDefault) {
    projected.thinkingDefault = thinkingDefault;
  }
  return projected;
}

export function projectBrowserModelChoice(value: unknown): JsonObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const source = value as JsonObject;
  const id = optionalString(source.id);
  const name = optionalString(source.name);
  const provider = optionalString(source.provider);
  if (!id || !name || !provider) {
    return null;
  }
  const projected: JsonObject = { id, name, provider };
  for (const key of ["alias"] as const) {
    const field = optionalString(source[key]);
    if (field) {
      projected[key] = field;
    }
  }
  for (const key of ["available", "reasoning"] as const) {
    if (typeof source[key] === "boolean") {
      projected[key] = source[key];
    }
  }
  if (typeof source.contextWindow === "number") {
    projected.contextWindow = source.contextWindow;
  }
  if (Array.isArray(source.input)) {
    projected.input = source.input.filter((entry): entry is string => typeof entry === "string");
  }
  return projected;
}
