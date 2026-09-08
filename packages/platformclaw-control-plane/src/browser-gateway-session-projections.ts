type JsonObject = Record<string, unknown>;

type ProjectBrowserSessionResultParams = {
  method: string;
  prepared: JsonObject;
  result: unknown;
  assertOwnedResultSessionKey(value: unknown): void;
  projectSessionPayloadForAccess(value: unknown): JsonObject | null;
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

function requireNonEmptyString(
  value: unknown,
  label: string,
  fail: (message: string) => never,
): string {
  return typeof value === "string" && value.length > 0
    ? value
    : fail(`Gateway returned an invalid ${label}`);
}

function requireNonNegativeInteger(
  value: unknown,
  label: string,
  fail: (message: string) => never,
): number {
  return Number.isInteger(value) && (value as number) >= 0
    ? (value as number)
    : fail(`Gateway returned an invalid ${label}`);
}

function projectOptionalNonEmptyString(
  value: unknown,
  label: string,
  fail: (message: string) => never,
): string | undefined {
  return value === undefined ? undefined : requireNonEmptyString(value, label, fail);
}

function projectOptionalNonNegativeInteger(
  value: unknown,
  label: string,
  fail: (message: string) => never,
): number | undefined {
  return value === undefined ? undefined : requireNonNegativeInteger(value, label, fail);
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

function projectCompactionCheckpoint(
  value: unknown,
  input: ProjectBrowserSessionResultParams,
): JsonObject {
  const checkpoint = asObject(value, "session compaction checkpoint", input.fail);
  const checkpointId = requireNonEmptyString(
    checkpoint.checkpointId,
    "session compaction checkpoint id",
    input.fail,
  );
  const sessionKey = requireNonEmptyString(
    checkpoint.sessionKey,
    "session compaction checkpoint key",
    input.fail,
  );
  input.assertOwnedResultSessionKey(sessionKey);
  const reason = checkpoint.reason;
  if (
    reason !== "manual" &&
    reason !== "auto-threshold" &&
    reason !== "overflow-retry" &&
    reason !== "timeout-retry"
  ) {
    return input.fail("Gateway returned an invalid session compaction checkpoint reason");
  }
  const projectTranscriptReference = (field: "preCompaction" | "postCompaction") => {
    const reference = asObject(
      checkpoint[field],
      `session compaction ${field} reference`,
      input.fail,
    );
    return {
      sessionId: requireNonEmptyString(
        reference.sessionId,
        `session compaction ${field} session id`,
        input.fail,
      ),
      ...(projectOptionalNonEmptyString(
        reference.leafId,
        `session compaction ${field} leaf id`,
        input.fail,
      ) !== undefined
        ? { leafId: reference.leafId }
        : {}),
      ...(projectOptionalNonEmptyString(
        reference.entryId,
        `session compaction ${field} entry id`,
        input.fail,
      ) !== undefined
        ? { entryId: reference.entryId }
        : {}),
    };
  };
  return {
    checkpointId,
    sessionKey,
    sessionId: requireNonEmptyString(
      checkpoint.sessionId,
      "session compaction checkpoint session id",
      input.fail,
    ),
    createdAt: requireNonNegativeInteger(
      checkpoint.createdAt,
      "session compaction checkpoint timestamp",
      input.fail,
    ),
    reason,
    ...(projectOptionalNonNegativeInteger(
      checkpoint.tokensBefore,
      "session compaction checkpoint tokens before",
      input.fail,
    ) !== undefined
      ? { tokensBefore: checkpoint.tokensBefore }
      : {}),
    ...(projectOptionalNonNegativeInteger(
      checkpoint.tokensAfter,
      "session compaction checkpoint tokens after",
      input.fail,
    ) !== undefined
      ? { tokensAfter: checkpoint.tokensAfter }
      : {}),
    ...(checkpoint.summary === undefined
      ? {}
      : typeof checkpoint.summary === "string"
        ? { summary: checkpoint.summary }
        : input.fail("Gateway returned an invalid session compaction checkpoint summary")),
    ...(projectOptionalNonEmptyString(
      checkpoint.firstKeptEntryId,
      "session compaction checkpoint first kept entry id",
      input.fail,
    ) !== undefined
      ? { firstKeptEntryId: checkpoint.firstKeptEntryId }
      : {}),
    preCompaction: projectTranscriptReference("preCompaction"),
    postCompaction: projectTranscriptReference("postCompaction"),
  };
}

function projectCompactionEntry(value: unknown, input: ProjectBrowserSessionResultParams) {
  const entry = asObject(value, "session compaction entry", input.fail);
  return {
    sessionId: requireNonEmptyString(
      entry.sessionId,
      "session compaction entry session id",
      input.fail,
    ),
    updatedAt: requireNonNegativeInteger(
      entry.updatedAt,
      "session compaction entry timestamp",
      input.fail,
    ),
  };
}

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
  if (input.method === "sessions.compaction.list") {
    const payload = asObject(input.result, "session compaction list result", fail);
    if (payload.ok !== true || !Array.isArray(payload.checkpoints)) {
      return input.fail("Gateway returned an invalid session compaction list result");
    }
    input.assertOwnedResultSessionKey(input.prepared.key);
    const key = requireNonEmptyString(payload.key, "session compaction list key", fail);
    input.assertOwnedResultSessionKey(key);
    const checkpoints = payload.checkpoints.map((checkpoint) =>
      projectCompactionCheckpoint(checkpoint, input),
    );
    if (checkpoints.some((checkpoint) => checkpoint.sessionKey !== key)) {
      return input.fail("Gateway returned a mismatched session compaction list result");
    }
    return {
      ok: true,
      key,
      checkpoints,
    };
  }
  if (
    input.method === "sessions.compaction.branch" ||
    input.method === "sessions.compaction.restore"
  ) {
    const operation = input.method.endsWith("branch") ? "branch" : "restore";
    const payload = asObject(input.result, `session compaction ${operation} result`, fail);
    if (payload.ok !== true) {
      return input.fail(`Gateway returned an invalid session compaction ${operation} result`);
    }
    input.assertOwnedResultSessionKey(input.prepared.key);
    const key = requireNonEmptyString(payload.key, `session compaction ${operation} key`, fail);
    const sessionId = requireNonEmptyString(
      payload.sessionId,
      `session compaction ${operation} session id`,
      fail,
    );
    input.assertOwnedResultSessionKey(key);
    const sourceKey =
      operation === "branch"
        ? requireNonEmptyString(payload.sourceKey, "session compaction branch source key", fail)
        : undefined;
    if (operation === "branch") {
      input.assertOwnedResultSessionKey(sourceKey);
    }
    const checkpoint = projectCompactionCheckpoint(payload.checkpoint, input);
    if (
      checkpoint.checkpointId !== input.prepared.checkpointId ||
      checkpoint.sessionKey !== (operation === "branch" ? sourceKey : key)
    ) {
      return input.fail(`Gateway returned a mismatched session compaction ${operation} result`);
    }
    const entry = projectCompactionEntry(payload.entry, input);
    if (entry.sessionId !== sessionId) {
      return input.fail(`Gateway returned a mismatched session compaction ${operation} entry`);
    }
    return {
      ok: true,
      ...(operation === "branch" ? { sourceKey } : {}),
      key,
      sessionId,
      checkpoint,
      entry,
    };
  }
  if (input.method === "sessions.branches.list") {
    const payload = asObject(input.result, "session branches list result", fail);
    if (!Array.isArray(payload.branches)) {
      return input.fail("Gateway returned an invalid session branches list result");
    }
    input.assertOwnedResultSessionKey(input.prepared.sessionKey);
    return {
      branches: payload.branches.map((branch) => {
        const value = asObject(branch, "session branch", fail);
        return {
          leafEntryId: requireNonEmptyString(value.leafEntryId, "session branch leaf id", fail),
          headline:
            typeof value.headline === "string"
              ? value.headline
              : fail("Gateway returned an invalid session branch headline"),
          messageCount: requireNonNegativeInteger(
            value.messageCount,
            "session branch message count",
            fail,
          ),
          ...(projectOptionalNonEmptyString(
            value.updatedAt,
            "session branch update timestamp",
            fail,
          ) !== undefined
            ? { updatedAt: value.updatedAt }
            : {}),
          active:
            typeof value.active === "boolean"
              ? value.active
              : fail("Gateway returned an invalid session branch active state"),
        };
      }),
    };
  }
  if (input.method === "sessions.branches.switch") {
    asObject(input.result, "session branch switch result", fail);
    input.assertOwnedResultSessionKey(input.prepared.sessionKey);
    return {};
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
  if (input.method === "sessions.list") {
    const payload = asObject(input.result, "sessions.list result", fail);
    if (!Array.isArray(payload.sessions)) {
      return input.fail("Gateway returned an invalid sessions.list result");
    }
    const sessions = payload.sessions;
    const projectedSessions = sessions.map((session) =>
      input.projectSessionPayloadForAccess(session),
    );
    return projectedSessions.some((session) => session === null)
      ? input.fail("Gateway returned a session outside the browser binding")
      : { ...payload, sessions: projectedSessions };
  }
  if (input.method === "sessions.describe") {
    const payload = asObject(input.result, "session description", fail);
    if (payload.session === null) {
      return payload;
    }
    const session = input.projectSessionPayloadForAccess(payload.session);
    return session
      ? { ...payload, session }
      : input.fail("Gateway returned a session outside the browser binding");
  }
  return undefined;
}
