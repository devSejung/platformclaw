import type { OpenClawPluginApi } from "../api.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { importMemoryWikiDocuments, MemoryWikiEditValidationError } from "./document-edit.js";

/** Batch source import reuses the gateway's authorized agent/config owner. */
export function registerMemoryWikiDocumentImportGatewayMethod(
  api: OpenClawPluginApi,
  resolveRequestContext: (request: Record<string, unknown>) => { config: ResolvedMemoryWikiConfig },
) {
  api.registerGatewayMethod(
    "wiki.document.import",
    async ({ params: requestParams, respond }) => {
      try {
        if (
          Object.keys(requestParams).some(
            (key) => !["agentId", "importId", "documents"].includes(key),
          ) ||
          typeof requestParams.importId !== "string"
        ) {
          throw new MemoryWikiEditValidationError(
            "Wiki import requires importId and documents only.",
          );
        }
        const { config } = resolveRequestContext(requestParams);
        respond(
          true,
          await importMemoryWikiDocuments({
            config,
            importId: requestParams.importId,
            documents: requestParams.documents,
          }),
        );
      } catch (error) {
        respond(false, undefined, {
          code: error instanceof MemoryWikiEditValidationError ? "INVALID_REQUEST" : "UNAVAILABLE",
          message:
            error instanceof MemoryWikiEditValidationError
              ? error.message
              : "Wiki import could not be confirmed. Retry the same selection to check saved files.",
        });
      }
    },
    { scope: "operator.write" },
  );
}
