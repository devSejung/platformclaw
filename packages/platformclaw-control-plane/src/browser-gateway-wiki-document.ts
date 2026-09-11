import { wikiPath } from "./browser-gateway-content-paths.js";
import {
  failObject,
  optionalEnum,
  optionalText,
  text,
  type JsonObject,
  type ProjectionFailure,
} from "./browser-gateway-wiki-projection.js";

export const WIKI_CONTENT_HASH = /^[a-f0-9]{64}$/u;
export const MAX_WIKI_CONTENT_CHARS = 1024 * 1024;

export function personalWikiPagePath(value: unknown, fail: ProjectionFailure): string {
  const path = wikiPath(value, "personal Wiki page path", fail);
  if (
    path !== value ||
    path.split("").some((character) => character.charCodeAt(0) < 32 || character === ":")
  ) {
    return fail("Wiki mutation requires a canonical personal Wiki page path");
  }
  return path;
}

export function projectWikiDocumentResult(params: {
  method: string;
  request: JsonObject;
  result: unknown;
  agentId: string;
  fail: ProjectionFailure;
}): JsonObject | null | undefined {
  if (params.method === "wiki.delete") {
    const payload = failObject(params.result, "wiki deletion", params.fail);
    if (
      payload.agentId !== params.agentId ||
      personalWikiPagePath(payload.path, params.fail) !== params.request.path ||
      payload.deleted !== true ||
      typeof payload.indexesRefreshed !== "boolean"
    ) {
      return params.fail("Gateway returned invalid personal Wiki deletion result");
    }
    return {
      agentId: params.agentId,
      path: payload.path,
      deleted: true,
      indexesRefreshed: payload.indexesRefreshed,
    };
  }
  if (params.method === "wiki.document.save") {
    const payload = failObject(params.result, "wiki document save", params.fail);
    if (
      personalWikiPagePath(payload.path, params.fail) !== params.request.path ||
      typeof payload.saved !== "boolean" ||
      typeof payload.indexesRefreshed !== "boolean" ||
      typeof payload.revision !== "string" ||
      !WIKI_CONTENT_HASH.test(payload.revision)
    ) {
      return params.fail("Gateway returned invalid Wiki save result");
    }
    return {
      path: payload.path,
      saved: payload.saved,
      indexesRefreshed: payload.indexesRefreshed,
      revision: payload.revision,
    };
  }
  if (params.method !== "wiki.document.get") {
    return undefined;
  }
  if (params.result === null) {
    return null;
  }
  const item = failObject(params.result, "wiki document", params.fail);
  const editMode =
    item.editMode === null
      ? undefined
      : optionalEnum(item.editMode, ["body", "notes"], "wiki edit mode", params.fail);
  const readOnlyReason = optionalEnum(
    item.readOnlyReason,
    ["generated-report", "source-managed", "page-too-large", "shared-vault"],
    "wiki read-only reason",
    params.fail,
  );
  const result: JsonObject = {
    path: wikiPath(item.path, "wiki document path", params.fail),
    title: text(item.title, "wiki document title", params.fail),
    kind: text(item.kind, "wiki document kind", params.fail, 256),
    displayContent: text(
      item.displayContent,
      "wiki display content",
      params.fail,
      MAX_WIKI_CONTENT_CHARS,
    ),
    sourceContent: text(
      item.sourceContent,
      "wiki source content",
      params.fail,
      MAX_WIKI_CONTENT_CHARS,
    ),
    editMode: editMode ?? null,
    ...(readOnlyReason ? { readOnlyReason } : {}),
  };
  if (editMode) {
    result.editableContent = text(
      item.editableContent,
      "wiki editable content",
      params.fail,
      MAX_WIKI_CONTENT_CHARS,
    );
    result.revision =
      typeof item.revision === "string" && WIKI_CONTENT_HASH.test(item.revision)
        ? item.revision
        : params.fail("Gateway returned Wiki edit data without a valid revision");
  }
  const sourceType = optionalText(item.sourceType, "wiki source type", params.fail, 256);
  const updatedAt = optionalText(item.updatedAt, "wiki updatedAt", params.fail, 256);
  return {
    ...result,
    ...(sourceType ? { sourceType } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}
