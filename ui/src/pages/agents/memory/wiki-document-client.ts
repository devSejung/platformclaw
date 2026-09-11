import type { DreamingState } from "./dreaming.ts";
import { readWikiPagePreview, type WikiPagePreview } from "./wiki-page-preview.ts";

type WikiDocumentClient = NonNullable<DreamingState["client"]>;

type WikiSaveParams = {
  path: string;
  editMode: "body" | "notes";
  content: string;
  expectedRevision: string;
};

function withAgentId(agentId: string | null): { agentId?: string } {
  return agentId ? { agentId } : {};
}

export async function requestWikiPage(params: {
  client: WikiDocumentClient;
  lookup: string;
  agentId: string | null;
  isCurrent: () => boolean;
}): Promise<WikiPagePreview | null> {
  const payload = await params.client.request("wiki.document.get", {
    lookup: params.lookup,
    ...withAgentId(params.agentId),
  });
  return params.isCurrent() ? readWikiPagePreview(payload, params.lookup) : null;
}

export async function saveWikiPage(params: {
  client: WikiDocumentClient;
  document: WikiSaveParams;
  agentId: string | null;
  isCurrent: () => boolean;
}): Promise<WikiPagePreview | null> {
  const saveResult = await params.client.request<{ saved: boolean; indexesRefreshed: boolean }>(
    "wiki.document.save",
    { ...params.document, ...withAgentId(params.agentId) },
  );
  if (!params.isCurrent()) {
    return null;
  }
  const payload = await params.client.request("wiki.document.get", {
    lookup: params.document.path,
    ...withAgentId(params.agentId),
  });
  return params.isCurrent()
    ? { ...readWikiPagePreview(payload, params.document.path), ...saveResult }
    : null;
}
