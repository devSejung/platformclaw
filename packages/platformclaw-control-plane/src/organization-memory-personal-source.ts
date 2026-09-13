import type { PersonalOrganizationMemorySource } from "./contracts.js";

type GatewayRequester = {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
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

/** Resolve a complete native personal Wiki claim through the Wiki-owned Gateway contract. */
export async function resolvePersonalOrganizationMemorySource(params: {
  gateway: GatewayRequester;
  agentId: string;
  lookup: string;
  proposedText?: string;
}): Promise<PersonalOrganizationMemorySource | null> {
  const resolved = await params.gateway.request<PersonalOrganizationMemorySource | null>(
    "wiki.references.resolve",
    {
      agentId: params.agentId,
      lookup: params.lookup,
      ...(params.proposedText === undefined ? {} : { proposedText: params.proposedText }),
    },
  );
  if (
    !resolved ||
    typeof resolved.claimId !== "string" ||
    !resolved.claimId ||
    !isSafeVirtualClaimId(resolved.claimId) ||
    !Number.isSafeInteger(resolved.revision) ||
    resolved.revision < 1
  ) {
    return null;
  }
  const identity = {
    claimId: resolved.claimId,
    revision: resolved.revision,
  };
  if (params.proposedText === undefined) {
    return identity;
  }
  if (
    !Array.isArray(resolved.references) ||
    resolved.references.length > 32 ||
    typeof resolved.referencesTextHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(resolved.referencesTextHash)
  ) {
    return null;
  }
  // Preserve the existing reference-free promotion shape while moving grammar ownership
  // behind the Wiki Gateway boundary.
  if (resolved.references.length === 0) {
    return identity;
  }
  return {
    ...identity,
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
