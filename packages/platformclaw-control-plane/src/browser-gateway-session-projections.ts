type JsonObject = Record<string, unknown>;

type ProjectBrowserSessionResultParams = {
  method: string;
  prepared: JsonObject;
  result: unknown;
  assertOwnedResultSessionKey(value: unknown): void;
  payloadBelongsToAccess(value: unknown): boolean;
  fail(message: string): never;
};

function asObject(value: unknown, label: string, fail: (message: string) => never): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fail(`Gateway returned an invalid ${label}`);
  }
  return value as JsonObject;
}

export function projectBrowserSessionResult(input: ProjectBrowserSessionResultParams): unknown {
  const fail = (message: string): never => input.fail(message);
  if (input.method === "sessions.patch") {
    const payload = asObject(input.result, "session patch result", fail);
    if (payload.ok !== true) {
      return input.fail("Gateway returned an invalid session patch result");
    }
    input.assertOwnedResultSessionKey(input.prepared.key);
    return { ok: true, key: input.prepared.key };
  }
  if (input.method === "sessions.delete") {
    const payload = asObject(input.result, "session delete result", fail);
    if (typeof payload.deleted !== "boolean") {
      return input.fail("Gateway returned an invalid session delete result");
    }
    input.assertOwnedResultSessionKey(input.prepared.key);
    return { deleted: payload.deleted };
  }
  if (input.method === "sessions.reset") {
    input.assertOwnedResultSessionKey(input.prepared.key);
    return {};
  }
  if (input.method === "sessions.compact") {
    const payload = asObject(input.result, "session compact result", fail);
    if (typeof payload.compacted !== "boolean") {
      return input.fail("Gateway returned an invalid session compact result");
    }
    input.assertOwnedResultSessionKey(payload.key ?? input.prepared.key);
    const result =
      payload.result && typeof payload.result === "object" && !Array.isArray(payload.result)
        ? (payload.result as JsonObject)
        : undefined;
    return {
      ...(typeof payload.ok === "boolean" ? { ok: payload.ok } : {}),
      compacted: payload.compacted,
      ...(typeof payload.reason === "string" ? { reason: payload.reason } : {}),
      ...(result
        ? {
            result: {
              ...(typeof result.tokensBefore === "number"
                ? { tokensBefore: result.tokensBefore }
                : {}),
              ...(typeof result.tokensAfter === "number"
                ? { tokensAfter: result.tokensAfter }
                : {}),
            },
          }
        : {}),
    };
  }
  if (input.method === "sessions.steer") {
    const payload = asObject(input.result, "session steer result", fail);
    if (typeof payload.status !== "string") {
      return input.fail("Gateway returned an invalid session steer result");
    }
    input.assertOwnedResultSessionKey(input.prepared.key);
    return {
      status: payload.status,
      ...(typeof payload.runId === "string" ? { runId: payload.runId } : {}),
    };
  }
  if (input.method === "sessions.describe") {
    const payload = asObject(input.result, "session description", fail);
    if (payload.session !== null && !input.payloadBelongsToAccess(payload.session)) {
      return input.fail("Gateway returned a session outside the browser binding");
    }
    return payload;
  }
  return undefined;
}
