import {
  memoryWikiPromotionRevision,
  parseMemoryWikiReferenceSpans,
} from "@openclaw/memory-wiki/reference-api";
import type { PersonalOrganizationMemorySource } from "./contracts.js";

type GatewayRequester = {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
};

type WikiGetResult = {
  corpus?: unknown;
  path?: unknown;
  id?: unknown;
  content?: unknown;
  totalLines?: unknown;
  truncated?: unknown;
  updatedAt?: unknown;
};

function isSafeVirtualClaimId(value: string): boolean {
  return (
    value.length <= 1_000 &&
    !value.includes("\0") &&
    !value.includes("\\") &&
    !value.startsWith("/") &&
    !/^[a-zA-Z]:/u.test(value) &&
    !value.split("/").includes("..")
  );
}

/** Resolve only a complete native personal Wiki page; raw memory files are not promotion claims. */
export async function resolvePersonalOrganizationMemorySource(params: {
  gateway: GatewayRequester;
  agentId: string;
  lookup: string;
  proposedText?: string;
}): Promise<PersonalOrganizationMemorySource | null> {
  // Reference-free publication retains the existing complete wiki.get contract.
  if (
    params.proposedText !== undefined &&
    parseMemoryWikiReferenceSpans(params.proposedText).length > 0
  ) {
    const resolved = await params.gateway.request<PersonalOrganizationMemorySource | null>(
      "wiki.references.resolve",
      { agentId: params.agentId, lookup: params.lookup, proposedText: params.proposedText },
    );
    if (
      !resolved ||
      typeof resolved.claimId !== "string" ||
      !resolved.claimId ||
      !isSafeVirtualClaimId(resolved.claimId) ||
      !Number.isSafeInteger(resolved.revision) ||
      resolved.revision < 1 ||
      !Array.isArray(resolved.references) ||
      resolved.references.length > 32 ||
      typeof resolved.referencesTextHash !== "string" ||
      !/^[a-f0-9]{64}$/u.test(resolved.referencesTextHash)
    ) {
      return null;
    }
    return {
      claimId: resolved.claimId,
      revision: resolved.revision,
      referencesTextHash: resolved.referencesTextHash,
      references: resolved.references.map((reference) => ({
        start: reference.start,
        end: reference.end,
        claimId: reference.claimId,
        revision: reference.revision,
        kind: reference.kind,
        scopeId: reference.scopeId,
      })),
    };
  }
  const page = await params.gateway.request<WikiGetResult | null>("wiki.get", {
    agentId: params.agentId,
    lookup: params.lookup,
    fromLine: 1,
    lineCount: 10_000,
  });
  if (
    !page ||
    page.corpus !== "wiki" ||
    page.truncated === true ||
    typeof page.path !== "string" ||
    typeof page.content !== "string"
  ) {
    return null;
  }
  const claimId = typeof page.id === "string" && page.id.trim() ? page.id.trim() : page.path.trim();
  if (!claimId || !isSafeVirtualClaimId(claimId)) {
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
}
