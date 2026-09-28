import { readStringParam } from "openclaw/plugin-sdk/param-readers";
import type { OpenClawPluginApi } from "../api.js";
import {
  listMemoryWikiArchive,
  readMemoryWikiArchive,
  putMemoryWikiAttachment,
  deleteMemoryWikiAttachment,
} from "./archive.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { MemoryWikiEditConflictError, MemoryWikiEditValidationError } from "./document-edit.js";

/** Artifact transport reuses the gateway's authorized agent/config owner. */
export function registerMemoryWikiArtifactGatewayMethods(
  api: OpenClawPluginApi,
  resolveRequestContext: (request: Record<string, unknown>) => {
    config: ResolvedMemoryWikiConfig;
    agentId?: string;
  },
) {
  for (const operation of ["manifest", "read", "put", "delete"] as const) {
    const method =
      operation === "manifest" || operation === "read"
        ? `wiki.archive.${operation}`
        : `wiki.attachment.${operation}`;
    api.registerGatewayMethod(
      method,
      async ({ params: request, respond }) => {
        try {
          const { config, agentId } = resolveRequestContext(request);
          const allowed =
            operation === "manifest"
              ? ["agentId", "kind"]
              : operation === "read"
                ? ["agentId", "path", "expectedRevision", "offset", "length"]
                : operation === "put"
                  ? ["agentId", "path", "contentBase64", "expectedRevision"]
                  : ["agentId", "path", "expectedRevision"];
          if (Object.keys(request).some((key) => !allowed.includes(key))) {
            throw new MemoryWikiEditValidationError("Unsupported Wiki artifact fields.");
          }
          const filePath =
            operation === "manifest" ? "" : readStringParam(request, "path", { required: true });
          const expectedRevision =
            operation === "manifest" || operation === "put"
              ? readStringParam(request, "expectedRevision")
              : readStringParam(request, "expectedRevision", { required: true });
          if (
            operation === "read" &&
            ((request.offset !== undefined && typeof request.offset !== "number") ||
              (request.length !== undefined && typeof request.length !== "number"))
          ) {
            throw new MemoryWikiEditValidationError("Archive offset and length must be numbers.");
          }
          if (operation === "put" && typeof request.contentBase64 !== "string") {
            throw new MemoryWikiEditValidationError("Attachment requires contentBase64.");
          }
          if (request.kind !== undefined && request.kind !== "attachment") {
            throw new MemoryWikiEditValidationError(
              "Archive kind must be attachment when specified.",
            );
          }
          const result =
            operation === "manifest"
              ? await listMemoryWikiArchive(config, request.kind as "attachment" | undefined)
              : operation === "read"
                ? await readMemoryWikiArchive({
                    config,
                    path: filePath,
                    expectedRevision: expectedRevision!,
                    offset: request.offset as number | undefined,
                    length: request.length as number | undefined,
                  })
                : operation === "put"
                  ? await putMemoryWikiAttachment({
                      config,
                      path: filePath,
                      contentBase64: request.contentBase64 as string,
                      ...(expectedRevision === undefined ? {} : { expectedRevision }),
                    })
                  : await deleteMemoryWikiAttachment({
                      config,
                      path: filePath,
                      expectedRevision: expectedRevision!,
                    });
          respond(true, { agentId, ...result });
        } catch (error) {
          respond(false, undefined, {
            code:
              error instanceof MemoryWikiEditConflictError
                ? "CONFLICT"
                : error instanceof MemoryWikiEditValidationError
                  ? "INVALID_REQUEST"
                  : "UNAVAILABLE",
            message:
              error instanceof MemoryWikiEditConflictError ||
              error instanceof MemoryWikiEditValidationError
                ? error.message
                : "Wiki artifact operation could not complete. Reload the Wiki and try again.",
          });
        }
      },
      {
        scope:
          operation === "manifest" || operation === "read" ? "operator.read" : "operator.write",
      },
    );
  }
}
