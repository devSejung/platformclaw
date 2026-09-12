import type { OpenClawConfig } from "../api.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { createWikiLinkTargetIndex, resolveWikiLinkTarget } from "./link-resolution.js";
import { getMemoryWikiPage, readQueryableWikiPages } from "./query.js";
import {
  memoryWikiPromotionRevision,
  memoryWikiReferenceTextHash,
  parseMemoryWikiReferenceSpans,
} from "./reference-spans.js";

function virtualClaimId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 1_000 &&
    !value.includes("\0") &&
    !value.includes("\\") &&
    !value.startsWith("/") &&
    !/^[a-zA-Z]:/u.test(value) &&
    !value.split("/").includes("..")
  );
}

/** Resolve only the submitted text's links within the current native personal vault. */
export async function resolveMemoryWikiPromotionReferences(params: {
  config: ResolvedMemoryWikiConfig;
  appConfig?: OpenClawConfig;
  lookup: string;
  proposedText?: string;
}) {
  if (params.config.vault.scope !== "agent" || !params.config.agentId) {
    throw new Error("Personal Wiki reference resolution requires an exact agent-scoped vault.");
  }
  if (
    params.proposedText !== undefined &&
    Buffer.byteLength(params.proposedText, "utf8") > 256 * 1024
  ) {
    throw new Error("Submitted Wiki text exceeds the complete document limit.");
  }
  const get = async (lookup: string) =>
    await getMemoryWikiPage({
      config: params.config,
      appConfig: params.appConfig,
      agentId: params.config.agentId,
      lookup,
      fromLine: 1,
      lineCount: 10_000,
      searchCorpus: "wiki",
      searchBackend: "local",
    });
  const identity = (page: Awaited<ReturnType<typeof get>>) => {
    if (!page || page.corpus !== "wiki" || page.truncated) {
      return null;
    }
    const claimId = page.id?.trim() || page.path.trim();
    if (!virtualClaimId(claimId)) {
      return null;
    }
    return {
      claimId,
      revision: memoryWikiPromotionRevision({
        claimId,
        content: page.content,
        totalLines: page.totalLines,
        updatedAt: page.updatedAt,
      }),
    };
  };
  const source = await get(params.lookup);
  const sourceIdentity = identity(source);
  if (!source || !sourceIdentity) {
    return null;
  }
  if (params.proposedText === undefined) {
    return sourceIdentity;
  }
  const spans = parseMemoryWikiReferenceSpans(params.proposedText, source.path);
  const index = createWikiLinkTargetIndex(await readQueryableWikiPages(params.config.vault.path));
  const references = [];
  for (const span of spans) {
    // Ambiguous or unavailable private tokens carry offsets only, so callers can remove aliases too.
    const matches = resolveWikiLinkTarget(index, span.target);
    const target = matches.length === 1 ? matches[0] : undefined;
    const resolved = target ? identity(await get(target.relativePath)) : null;
    references.push({
      start: span.start,
      end: span.end,
      ...(resolved ? { ...resolved, kind: "personal" as const } : {}),
    });
  }
  return {
    ...sourceIdentity,
    references,
    referencesTextHash: memoryWikiReferenceTextHash(params.proposedText),
  };
}
