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

function projectEditorAttachments(value: unknown): Array<{ mimeType: string; data: string }> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }
    const attachment = entry as JsonObject;
    return typeof attachment.mimeType === "string" && typeof attachment.data === "string"
      ? [{ mimeType: attachment.mimeType, data: attachment.data }]
      : [];
  });
}

function projectObjectKeys(value: JsonObject, keys: readonly string[]): JsonObject {
  const projected: JsonObject = {};
  for (const key of keys) {
    if (value[key] !== undefined) {
      projected[key] = value[key];
    }
  }
  return projected;
}

const SESSION_FILE_KEYS = [
  "path",
  "workspacePath",
  "name",
  "kind",
  "missing",
  "size",
  "updatedAtMs",
  "content",
  "hash",
  "mimeType",
  "contentEncoding",
  "previewKind",
] as const;

const ARTIFACT_SUMMARY_KEYS = [
  "id",
  "type",
  "title",
  "mimeType",
  "sizeBytes",
  "sessionKey",
  "runId",
  "taskId",
  "messageSeq",
  "source",
  "download",
] as const;

function projectArtifactSummary(
  value: unknown,
  input: ProjectBrowserSessionResultParams,
): JsonObject {
  const artifact = asObject(value, "artifact summary", (message) => input.fail(message));
  if (artifact.sessionKey === undefined) {
    return input.fail("Gateway returned an artifact without session ownership");
  }
  input.assertOwnedResultSessionKey(artifact.sessionKey);
  return projectObjectKeys(artifact, ARTIFACT_SUMMARY_KEYS);
}

export function projectBrowserSessionResult(input: ProjectBrowserSessionResultParams): unknown {
  const fail = (message: string): never => input.fail(message);
  if (input.method === "sessions.files.list") {
    const payload = asObject(input.result, "session files list result", fail);
    input.assertOwnedResultSessionKey(payload.sessionKey);
    if (!Array.isArray(payload.files)) {
      return input.fail("Gateway returned an invalid session files list result");
    }
    const browser =
      payload.browser === undefined
        ? undefined
        : asObject(payload.browser, "session file browser result", fail);
    const browserEntries = browser
      ? Array.isArray(browser.entries)
        ? browser.entries
        : input.fail("Gateway returned an invalid session file browser result")
      : undefined;
    return {
      sessionKey: payload.sessionKey,
      ...(typeof payload.gitCheckout === "boolean" ? { gitCheckout: payload.gitCheckout } : {}),
      files: payload.files.map((file) =>
        projectObjectKeys(asObject(file, "session file entry", fail), SESSION_FILE_KEYS),
      ),
      ...(browser
        ? {
            browser: {
              ...projectObjectKeys(browser, ["path", "parentPath", "search", "truncated"]),
              entries: browserEntries!.map((entry: unknown) =>
                projectObjectKeys(asObject(entry, "session file browser entry", fail), [
                  "path",
                  "name",
                  "kind",
                  "sessionKind",
                  "size",
                  "updatedAtMs",
                ]),
              ),
            },
          }
        : {}),
    };
  }
  if (input.method === "sessions.files.get") {
    const payload = asObject(input.result, "session file result", fail);
    input.assertOwnedResultSessionKey(payload.sessionKey);
    return {
      sessionKey: payload.sessionKey,
      file: projectObjectKeys(
        asObject(payload.file, "session file entry", fail),
        SESSION_FILE_KEYS,
      ),
    };
  }
  if (input.method === "artifacts.list") {
    const payload = asObject(input.result, "artifact list result", fail);
    input.assertOwnedResultSessionKey(input.prepared.sessionKey);
    if (!Array.isArray(payload.artifacts)) {
      return input.fail("Gateway returned an invalid artifact list result");
    }
    return {
      artifacts: payload.artifacts.map((artifact) => projectArtifactSummary(artifact, input)),
    };
  }
  if (input.method === "artifacts.download") {
    const payload = asObject(input.result, "artifact download result", fail);
    input.assertOwnedResultSessionKey(input.prepared.sessionKey);
    const artifact = projectArtifactSummary(payload.artifact, input);
    if (artifact.id !== input.prepared.artifactId) {
      return input.fail("Gateway returned a different artifact than requested");
    }
    return {
      artifact,
      ...projectObjectKeys(payload, ["encoding", "data", "url", "expiresAt"]),
    };
  }
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
  if (input.method === "sessions.fork") {
    const payload = asObject(input.result, "session fork result", fail);
    input.assertOwnedResultSessionKey(payload.sessionKey);
    const editorAttachments = projectEditorAttachments(payload.editorAttachments);
    return {
      sessionKey: payload.sessionKey,
      ...(typeof payload.editorText === "string" ? { editorText: payload.editorText } : {}),
      ...(editorAttachments.length > 0 ? { editorAttachments } : {}),
    };
  }
  if (input.method === "sessions.rewind") {
    const payload = asObject(input.result, "session rewind result", fail);
    input.assertOwnedResultSessionKey(input.prepared.sessionKey);
    const editorAttachments = projectEditorAttachments(payload.editorAttachments);
    return {
      ...(typeof payload.editorText === "string" ? { editorText: payload.editorText } : {}),
      ...(editorAttachments.length > 0 ? { editorAttachments } : {}),
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
