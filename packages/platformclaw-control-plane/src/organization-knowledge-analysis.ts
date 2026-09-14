import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  OrganizationKnowledgeAnalyzer,
  OrganizationKnowledgeAnalysis,
  OrganizationKnowledgeAnalysisInput,
  OrganizationKnowledgeClaim,
  OrganizationKnowledgeComparison,
  OrganizationKnowledgeProposalKind,
} from "./organization-memory-knowledge-contracts.js";

export const ORGANIZATION_KNOWLEDGE_POLICY_VERSION = "candidate-pairs-v1";
export const ORGANIZATION_KNOWLEDGE_ANALYSIS_LIMITS = {
  claims: 80,
  claimChars: 8_000,
  evidencePerClaim: 16,
  evidenceChars: 500,
  pairs: 40,
  summaryChars: 2_000,
  proposalChars: 8_000,
  analysisChars: 128_000,
} as const;

type Pair = [OrganizationKnowledgeClaim, OrganizationKnowledgeClaim];
type OrganizationKnowledgePairCompletion = (claims: Pair, signal: AbortSignal) => Promise<unknown>;

const kinds = new Set<OrganizationKnowledgeProposalKind>([
  "duplicate",
  "enrichment",
  "condition-difference",
  "conflict",
  "insufficient-evidence",
]);

function boundedText(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error("organization knowledge analysis returned invalid bounded text");
  }
  return value.trim();
}

/** Validate against the frozen pair, never against model-supplied scope or identifiers. */
function validateOrganizationKnowledgeComparison(
  value: unknown,
  claims: Pair,
): OrganizationKnowledgeComparison {
  if (!isRecord(value) || !kinds.has(value.kind as OrganizationKnowledgeProposalKind)) {
    throw new Error("organization knowledge analysis returned invalid comparison kind");
  }
  const allowedKeys = new Set(["kind", "claimIds", "claimRevisions", "summary", "proposedText"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new Error("organization knowledge analysis returned unexpected comparison fields");
  }
  const ids = value.claimIds;
  const revisions = value.claimRevisions;
  if (
    !Array.isArray(ids) ||
    ids.length !== 2 ||
    new Set(ids).size !== 2 ||
    !claims.every((claim) => ids.includes(claim.id)) ||
    !Array.isArray(revisions) ||
    revisions.length !== 2 ||
    !claims.every((claim) =>
      revisions.some(
        (citation) =>
          isRecord(citation) && citation.id === claim.id && citation.revision === claim.revision,
      ),
    )
  ) {
    throw new Error("organization knowledge analysis returned unpinned claim citations");
  }
  const kind = value.kind as OrganizationKnowledgeProposalKind;
  // Missing evidence cannot support a conflict recommendation, even if the model asserts one.
  if (kind === "conflict" && claims.some((claim) => claim.evidence.length === 0)) {
    throw new Error("organization knowledge conflict requires cited evidence for both claims");
  }
  return {
    kind,
    claimIds: claims.map((claim) => claim.id),
    claimRevisions: claims.map(({ id, revision }) => ({ id, revision })),
    summary: boundedText(value.summary, ORGANIZATION_KNOWLEDGE_ANALYSIS_LIMITS.summaryChars),
    ...(value.proposedText === undefined
      ? {}
      : {
          proposedText: boundedText(
            value.proposedText,
            ORGANIZATION_KNOWLEDGE_ANALYSIS_LIMITS.proposalChars,
          ),
        }),
  };
}

function validateClaims(claims: OrganizationKnowledgeClaim[]) {
  const bounds = ORGANIZATION_KNOWLEDGE_ANALYSIS_LIMITS;
  if (
    claims.length > bounds.claims ||
    new Set(claims.map((claim) => claim.id)).size !== claims.length
  ) {
    throw new Error("organization knowledge claim count or identifiers exceed bounds");
  }
  for (const claim of claims) {
    if (!isRecord(claim) || !Array.isArray(claim.evidence)) {
      throw new Error("organization knowledge analysis requires claim evidence arrays");
    }
    boundedText(claim.id, 128);
    boundedText(claim.text, bounds.claimChars);
    if (
      !Number.isSafeInteger(claim.revision) ||
      claim.revision < 1 ||
      claim.evidence.length > bounds.evidencePerClaim
    ) {
      throw new Error("organization knowledge claim revision or evidence exceeds bounds");
    }
    for (const evidence of claim.evidence) {
      boundedText(evidence, bounds.evidenceChars);
    }
  }
}

function validateOrganizationKnowledgeAnalysisInput(
  value: unknown,
): OrganizationKnowledgeAnalysisInput {
  if (
    !isRecord(value) ||
    !Array.isArray(value.claims) ||
    Object.keys(value).some((key) => !["scopeId", "inputFingerprint", "claims"].includes(key))
  ) {
    throw new Error("organization knowledge analysis requires a bounded scope snapshot");
  }
  const scopeId = boundedText(value.scopeId, 128);
  const inputFingerprint = boundedText(value.inputFingerprint, 128);
  const claims = value.claims as OrganizationKnowledgeClaim[];
  validateClaims(claims);
  return {
    scopeId,
    inputFingerprint,
    claims: claims.map(({ id, revision, text, evidence }) => ({
      id,
      revision,
      text,
      evidence: [...evidence],
    })),
  };
}

function extractCandidateTerms(text: string): string[] {
  return (text.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}_]+/gu) ?? []).filter(
    (token) => token.length > 1 && !/^\d+$/u.test(token),
  );
}

/** Candidate retrieval is intentionally lightweight; the model verdict is still validated separately. */
export function createOrganizationKnowledgeAnalyzer(deps: {
  completePair: OrganizationKnowledgePairCompletion;
}): OrganizationKnowledgeAnalyzer {
  return async (input, signal) => {
    validateClaims(input.claims);
    signal.throwIfAborted();
    const claims = input.claims
      .map(({ id, revision, text, evidence }) => ({ id, revision, text, evidence: [...evidence] }))
      .toSorted((a, b) => a.id.localeCompare(b.id, "en"));
    const tokens = claims.map((claim) => new Set(extractCandidateTerms(claim.text)));
    // Preserve exact board/version identifiers independently of lexical token overlap.
    const identifiers = claims.map(
      (claim) =>
        new Set(
          (claim.text.match(/[\p{L}\p{N}][\p{L}\p{N}_./-]*/gu) ?? [])
            .filter((token) => /\d|[_./-]/u.test(token))
            .map((token) => token.toLowerCase()),
        ),
    );
    const ranked: Array<{ claims: Pair; score: number }> = [];
    for (let left = 0; left < claims.length; left += 1) {
      for (let right = left + 1; right < claims.length; right += 1) {
        const a = claims[left]!;
        const b = claims[right]!;
        const overlap = [...tokens[left]!].filter((token) => tokens[right]!.has(token));
        const sharedIdentifier = [...identifiers[left]!].some((token) =>
          identifiers[right]!.has(token),
        );
        const sameText = a.text.trim() === b.text.trim();
        if (sameText || sharedIdentifier || overlap.length >= 2) {
          ranked.push({
            claims: [a, b],
            score: (sameText ? 100 : 0) + (sharedIdentifier ? 20 : 0) + overlap.length,
          });
        }
      }
    }
    ranked.sort(
      (a, b) =>
        b.score - a.score ||
        a.claims[0].id.localeCompare(b.claims[0].id, "en") ||
        a.claims[1].id.localeCompare(b.claims[1].id, "en"),
    );
    const selected = ranked.slice(0, ORGANIZATION_KNOWLEDGE_ANALYSIS_LIMITS.pairs);
    const comparisons: OrganizationKnowledgeComparison[] = [];
    // Per-job bounded iteration does not alter Gateway or chat concurrency policy.
    for (const pair of selected) {
      signal.throwIfAborted();
      const raw = await deps.completePair(pair.claims, signal);
      signal.throwIfAborted();
      comparisons.push(validateOrganizationKnowledgeComparison(raw, pair.claims));
    }
    const allPairs = (claims.length * (claims.length - 1)) / 2;
    return validateOrganizationKnowledgeAnalysis(
      {
        summary:
          `Compared ${comparisons.length} related candidate pairs from ${claims.length} claims. ` +
          "Candidate retrieval is not an exhaustive semantic comparison; unrelated wording may be missed. " +
          (selected.length < ranked.length
            ? "The pair limit omitted additional candidates. "
            : "") +
          "Recommendations require human review and do not change approved knowledge.",
        comparisons,
        coverage: {
          strategy: "candidate-pairs",
          policyVersion: ORGANIZATION_KNOWLEDGE_POLICY_VERSION,
          candidatePairs: ranked.length,
          comparedPairs: comparisons.length,
          hasUncomparedPairs: comparisons.length < allPairs,
        },
      },
      input,
    );
  };
}

export function validateOrganizationKnowledgeAnalysis(
  value: unknown,
  input: OrganizationKnowledgeAnalysisInput,
): OrganizationKnowledgeAnalysis {
  if (
    !isRecord(value) ||
    !isRecord(value.coverage) ||
    !Array.isArray(value.comparisons) ||
    value.comparisons.length > ORGANIZATION_KNOWLEDGE_ANALYSIS_LIMITS.pairs ||
    JSON.stringify(value).length > ORGANIZATION_KNOWLEDGE_ANALYSIS_LIMITS.analysisChars
  ) {
    throw new Error("organization knowledge analysis response exceeds bounds");
  }
  const coverage = value.coverage;
  const allPairs = (input.claims.length * (input.claims.length - 1)) / 2;
  if (
    coverage.strategy !== "candidate-pairs" ||
    coverage.policyVersion !== ORGANIZATION_KNOWLEDGE_POLICY_VERSION ||
    !Number.isSafeInteger(coverage.candidatePairs) ||
    !Number.isSafeInteger(coverage.comparedPairs) ||
    typeof coverage.candidatePairs !== "number" ||
    typeof coverage.comparedPairs !== "number" ||
    coverage.candidatePairs < coverage.comparedPairs ||
    coverage.comparedPairs !== value.comparisons.length ||
    coverage.candidatePairs > allPairs ||
    coverage.hasUncomparedPairs !== coverage.comparedPairs < allPairs
  ) {
    throw new Error("organization knowledge analysis response has invalid coverage");
  }
  const claims = new Map(input.claims.map((claim) => [claim.id, claim]));
  const comparisons = value.comparisons.map((comparison) => {
    if (
      !isRecord(comparison) ||
      !Array.isArray(comparison.claimIds) ||
      comparison.claimIds.length !== 2
    ) {
      throw new Error("organization knowledge analysis response has invalid pair");
    }
    const left = claims.get(comparison.claimIds[0]);
    const right = claims.get(comparison.claimIds[1]);
    if (!left || !right) {
      throw new Error("organization knowledge analysis response cites unknown claim");
    }
    return validateOrganizationKnowledgeComparison(comparison, [left, right]);
  });
  if (
    new Set(comparisons.map((pair) => pair.claimIds.toSorted().join("\0"))).size !==
    comparisons.length
  ) {
    throw new Error("organization knowledge analysis response repeats pairs");
  }
  return {
    summary: boundedText(value.summary, ORGANIZATION_KNOWLEDGE_ANALYSIS_LIMITS.summaryChars),
    comparisons,
    coverage: {
      strategy: "candidate-pairs",
      policyVersion: ORGANIZATION_KNOWLEDGE_POLICY_VERSION,
      candidatePairs: coverage.candidatePairs,
      comparedPairs: coverage.comparedPairs,
      hasUncomparedPairs: coverage.hasUncomparedPairs,
    },
  };
}
