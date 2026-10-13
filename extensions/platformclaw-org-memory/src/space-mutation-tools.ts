import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { WikiHubMemoryClient } from "./client.js";
import type { registerSpaceRunProofs, SpaceRunOperationPayload } from "./space-run-proof.js";

export function sharedSpaceToolFailure(error: unknown) {
  const failure = asOptionalRecord(asOptionalRecord(error)?.memoryCorpusFailure);
  const details = {
    status: "error",
    ...(failure &&
    ["space-invalid", "space-conflict", "space-forbidden"].includes(String(failure.code)) &&
    typeof failure.error === "string" &&
    typeof failure.action === "string"
      ? {
          code: failure.code,
          error: failure.error.slice(0, 500),
          action: failure.action.slice(0, 500),
        }
      : {
          error: "Space service is unavailable",
          action:
            "Retry the Space request. If it keeps failing, ask an administrator to check the Space service.",
        }),
  };
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(details) }],
    details,
  };
}

export function registerSpaceMutationTools(
  api: OpenClawPluginApi,
  client: WikiHubMemoryClient,
  proofs: ReturnType<typeof registerSpaceRunProofs>,
) {
  for (const name of ["space_qa_append", "space_note_update"] as const) {
    const qa = name === "space_qa_append";
    api.registerTool(
      (context) =>
        context.agentId &&
        /^agent:[^:]+:space-session:[a-f0-9-]{36}$/u.test(context.sessionKey ?? "")
          ? {
              name,
              label: qa ? "Save shared Q&A post" : "Edit shared Notes",
              description: qa
                ? "Append a shareable Q&A summary to the current issue's Shared Q&A tab. This saves a separate post for current Space members without running another agent. Read the returned sharedQaRevision before writing; pass it as expectedRevision. The current employee is the author and the agent is marked as acting on their behalf. Keep requestId and the exact payload unchanged on retry. On conflict, read the latest Q&A revision and submit a new request. An explicit page must belong to the current Space and requires editor access. Body is limited to 8 KiB UTF-8. Do not include credentials, private tool activity, or unrelated personal conversations. Success returns the saved location, revision and receipt."
                : "Change the current issue's shared Notes for current Space members. Read the relevant note window and its page revision first. Use replace for one unique exact oldText occurrence; unseen surrounding text is preserved. Use append to add exact text at the end, including an empty note. Each text is limited to 8 KiB UTF-8. Pass the returned page revision as expectedRevision and a stable requestId. Retry with the same requestId and exact payload after an uncertain response. On stale revision or an absent/ambiguous oldText, read again and submit a new request; never replace the whole note with a truncated read. An explicit page must belong to the current Space and requires editor access. Success returns the Notes location, revision and receipt.",
              parameters: {
                type: "object",
                properties: {
                  spaceId: { type: "string", minLength: 1, maxLength: 128 },
                  pageId: { type: "string", minLength: 1, maxLength: 128 },
                  expectedRevision: { type: "integer", minimum: 1 },
                  requestId: { type: "string", minLength: 1, maxLength: 128 },
                  ...(qa
                    ? { body: { type: "string", minLength: 1, maxLength: 8192 } }
                    : {
                        operation: { type: "string", enum: ["append", "replace"] },
                        text: { type: "string", minLength: 1, maxLength: 8192 },
                        oldText: { type: "string", minLength: 1, maxLength: 8192 },
                        newText: { type: "string", maxLength: 8192 },
                      }),
                },
                required: qa
                  ? ["expectedRevision", "requestId", "body"]
                  : ["expectedRevision", "requestId", "operation"],
                additionalProperties: false,
              },
              execute: async (_id, raw) => {
                try {
                  const input = asOptionalRecord(raw);
                  const operation = qa
                    ? "qa.append"
                    : input?.operation === "append"
                      ? "note.append"
                      : input?.operation === "replace"
                        ? "note.replace"
                        : undefined;
                  const fields =
                    operation === "qa.append"
                      ? ["body"]
                      : operation === "note.append"
                        ? ["text"]
                        : ["oldText", "newText"];
                  const allowed = new Set([
                    "spaceId",
                    "pageId",
                    "expectedRevision",
                    "requestId",
                    ...fields,
                    ...(qa ? [] : ["operation"]),
                  ]);
                  if (
                    !input ||
                    !operation ||
                    Object.keys(input).some((key) => !allowed.has(key)) ||
                    !Number.isSafeInteger(input.expectedRevision) ||
                    (input.expectedRevision as number) < 1 ||
                    typeof input.requestId !== "string" ||
                    !input.requestId.trim() ||
                    input.requestId.length > 128 ||
                    ["spaceId", "pageId"].some(
                      (key) =>
                        input[key] !== undefined &&
                        (typeof input[key] !== "string" ||
                          !(input[key] as string).trim() ||
                          (input[key] as string).length > 128),
                    ) ||
                    fields.some(
                      (key) =>
                        typeof input[key] !== "string" ||
                        Buffer.byteLength(input[key] as string, "utf8") > 8192 ||
                        (key !== "newText" && !(input[key] as string).trim()),
                    )
                  ) {
                    const details = {
                      status: "error",
                      code: "space-invalid",
                      error: "Invalid shared Space mutation",
                      action:
                        "Use the declared mutation fields and bounded text; identity comes from your current personal Space execution.",
                    };
                    return {
                      isError: true,
                      content: [{ type: "text" as const, text: JSON.stringify(details) }],
                      details,
                    };
                  }
                  const common = {
                    requestId: input.requestId,
                    expectedRevision: input.expectedRevision as number,
                    ...(input.spaceId === undefined ? {} : { spaceId: input.spaceId as string }),
                    ...(input.pageId === undefined ? {} : { pageId: input.pageId as string }),
                  };
                  const payload: SpaceRunOperationPayload =
                    operation === "qa.append"
                      ? { ...common, operation, body: input.body as string }
                      : operation === "note.append"
                        ? { ...common, operation, text: input.text as string }
                        : {
                            ...common,
                            operation,
                            oldText: input.oldText as string,
                            newText: input.newText as string,
                          };
                  const proofId = proofs.issue(context, payload);
                  const result = await client.spaceMutation({ ...payload, proofId });
                  return {
                    content: [{ type: "text" as const, text: JSON.stringify(result) }],
                    details: result,
                  };
                } catch (error) {
                  return sharedSpaceToolFailure(error);
                }
              },
            }
          : null,
      { name },
    );
  }
}
