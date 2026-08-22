import { createHash } from "node:crypto";
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

function stableRevision(page: WikiGetResult, claimId: string): number {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        claimId,
        content: page.content,
        totalLines: page.totalLines,
        updatedAt: page.updatedAt,
      }),
    )
    .digest("hex");
  return Number.parseInt(digest.slice(0, 12), 16) + 1;
}

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
}): Promise<PersonalOrganizationMemorySource | null> {
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
  return { claimId, revision: stableRevision(page, claimId) };
}
