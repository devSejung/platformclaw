import { BrowserGatewayProxyError } from "./browser-gateway-contracts.js";
import type {
  OrganizationMemoryLifecycle,
  OrganizationMemoryLifecycleSnapshot,
  OrganizationMemoryClaim,
  OrganizationMemoryPromotionRequest,
  OrganizationMemoryPromotionSourceKind,
  OrganizationMemoryScopeKind,
} from "./contracts.js";
import {
  ControlPlaneAuthorizationError,
  ControlPlaneConflictError,
  ControlPlaneNotFoundError,
  ControlPlaneStateError,
} from "./contracts.js";

type JsonObject = Record<string, unknown>;

function textParam(request: JsonObject, name: string): string {
  const value = request[name];
  if (typeof value !== "string") {
    throw new BrowserGatewayProxyError("invalid-params", `${name} must be a string`);
  }
  return value;
}

function optionalTextParam(request: JsonObject, name: string): string | undefined {
  const value = request[name];
  if (value === undefined) {
    return undefined;
  }
  return textParam(request, name);
}

function integerParam(request: JsonObject, name: string): number {
  const value = request[name];
  if (!Number.isSafeInteger(value)) {
    throw new BrowserGatewayProxyError("invalid-params", `${name} must be an integer`);
  }
  return value as number;
}

function optionalIntegerParam(request: JsonObject, name: string): number | undefined {
  return request[name] === undefined ? undefined : integerParam(request, name);
}

function nonNegativeIntegerParam(request: JsonObject, name: string): number | undefined {
  const value = optionalIntegerParam(request, name);
  if (value !== undefined && value < 0) {
    throw new BrowserGatewayProxyError("invalid-params", `${name} must be non-negative`);
  }
  return value;
}

function projectRequest(value: OrganizationMemoryPromotionRequest) {
  return {
    id: value.id,
    sourceKind: value.sourceKind,
    sourceClaimId: value.sourceClaimId,
    sourceRevision: value.sourceRevision,
    targetKind: value.targetKind,
    targetScopeName: value.targetScopeName,
    proposedText: value.proposedText,
    evidence: value.evidence,
    reason: value.reason,
    status: value.status,
    createdAt: value.createdAt,
    ...(value.decidedAt === undefined ? {} : { decidedAt: value.decidedAt }),
    ...(value.decisionReason === undefined ? {} : { decisionReason: value.decisionReason }),
    ...(value.targetClaimId === undefined ? {} : { targetClaimId: value.targetClaimId }),
    canReview: value.canReview,
  };
}

function projectClaim(value: OrganizationMemoryClaim) {
  return {
    id: value.id,
    scopeKind: value.scopeKind,
    scopeName: value.scopeName,
    ...(value.scopeId === undefined ? {} : { scopeId: value.scopeId }),
    title: value.title,
    text: value.text,
    revision: value.revision,
    status: value.status,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(value.sourceClaimId === undefined ? {} : { sourceClaimId: value.sourceClaimId }),
  };
}

function projectSnapshot(value: OrganizationMemoryLifecycleSnapshot) {
  return {
    scopes: value.scopes.map((scope) => ({
      kind: scope.kind,
      name: scope.name,
      ...(scope.id === undefined ? {} : { id: scope.id }),
      ...(scope.parentScopeId === undefined ? {} : { parentScopeId: scope.parentScopeId }),
      canAdminister: scope.canAdminister,
    })),
    claims: value.claims.map(projectClaim),
    submitted: value.submitted.map(projectRequest),
    reviewable: value.reviewable.map(projectRequest),
    canApproveGlobal: value.canApproveGlobal,
    ...(value.next
      ? {
          next: {
            ...(value.next.claims === undefined ? {} : { claims: value.next.claims }),
            ...(value.next.submitted === undefined ? {} : { submitted: value.next.submitted }),
            ...(value.next.reviewable === undefined ? {} : { reviewable: value.next.reviewable }),
          },
        }
      : {}),
  };
}

async function lifecycleCall<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ControlPlaneAuthorizationError) {
      throw new BrowserGatewayProxyError("cross-agent-denied", error.message);
    }
    if (
      error instanceof ControlPlaneStateError ||
      error instanceof ControlPlaneConflictError ||
      error instanceof ControlPlaneNotFoundError
    ) {
      throw new BrowserGatewayProxyError("invalid-params", error.message);
    }
    throw error;
  }
}

function stringArrayParam(request: JsonObject, name: string): string[] {
  const value = request[name];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new BrowserGatewayProxyError("invalid-params", `${name} must be a string array`);
  }
  return value;
}

function sourceKind(request: JsonObject): OrganizationMemoryPromotionSourceKind {
  const value = textParam(request, "sourceKind");
  if (value !== "personal" && value !== "part" && value !== "group") {
    throw new BrowserGatewayProxyError("invalid-params", "sourceKind is invalid");
  }
  return value;
}

function targetKind(request: JsonObject): OrganizationMemoryScopeKind {
  const value = textParam(request, "targetKind");
  if (value !== "part" && value !== "group" && value !== "global") {
    throw new BrowserGatewayProxyError("invalid-params", "targetKind is invalid");
  }
  return value;
}

export async function requestBrowserOrganizationMemoryLifecycle(params: {
  lifecycle: OrganizationMemoryLifecycle | undefined;
  agentId: string;
  method: string;
  request: JsonObject;
  now: number;
}): Promise<{ handled: false } | { handled: true; result: unknown }> {
  if (!params.method.startsWith("platformclaw.memory.")) {
    return { handled: false };
  }
  if (!params.lifecycle) {
    throw new BrowserGatewayProxyError(
      "method-not-allowed",
      "organization memory lifecycle is unavailable",
    );
  }
  const owner = params.lifecycle;
  switch (params.method) {
    case "platformclaw.memory.lifecycle":
      return {
        handled: true,
        result: projectSnapshot(
          await lifecycleCall(() =>
            owner.getOrganizationMemoryLifecycle(params.agentId, {
              ...(nonNegativeIntegerParam(params.request, "claims") === undefined
                ? {}
                : { claims: nonNegativeIntegerParam(params.request, "claims") }),
              ...(nonNegativeIntegerParam(params.request, "submitted") === undefined
                ? {}
                : { submitted: nonNegativeIntegerParam(params.request, "submitted") }),
              ...(nonNegativeIntegerParam(params.request, "reviewable") === undefined
                ? {}
                : { reviewable: nonNegativeIntegerParam(params.request, "reviewable") }),
            }),
          ),
        ),
      };
    case "platformclaw.memory.promotion.submit":
      return {
        handled: true,
        result: projectRequest(
          await lifecycleCall(() =>
            owner.submitOrganizationMemoryPromotion({
              agentId: params.agentId,
              sourceKind: sourceKind(params.request),
              sourceClaimId: textParam(params.request, "sourceClaimId"),
              ...(optionalIntegerParam(params.request, "expectedSourceRevision") === undefined
                ? {}
                : {
                    expectedSourceRevision: optionalIntegerParam(
                      params.request,
                      "expectedSourceRevision",
                    ),
                  }),
              targetKind: targetKind(params.request),
              ...(optionalTextParam(params.request, "targetScopeId")
                ? { targetScopeId: optionalTextParam(params.request, "targetScopeId") }
                : {}),
              proposedText: textParam(params.request, "proposedText"),
              evidence: stringArrayParam(params.request, "evidence"),
              reason: textParam(params.request, "reason"),
              submittedAt: params.now,
            }),
          ),
        ),
      };
    case "platformclaw.memory.promotion.decide": {
      const decision = textParam(params.request, "decision");
      if (decision !== "approve" && decision !== "reject") {
        throw new BrowserGatewayProxyError("invalid-params", "decision is invalid");
      }
      return {
        handled: true,
        result: projectRequest(
          await lifecycleCall(() =>
            owner.decideOrganizationMemoryPromotion({
              agentId: params.agentId,
              requestId: textParam(params.request, "requestId"),
              decision,
              reason: textParam(params.request, "reason"),
              decidedAt: params.now,
            }),
          ),
        ),
      };
    }
    case "platformclaw.memory.claim.retire":
      return {
        handled: true,
        result: projectClaim(
          await lifecycleCall(() =>
            owner.retireOrganizationMemoryClaim({
              agentId: params.agentId,
              claimId: textParam(params.request, "claimId"),
              reason: textParam(params.request, "reason"),
              retiredAt: params.now,
            }),
          ),
        ),
      };
    case "platformclaw.memory.claim.purge":
      return {
        handled: true,
        result: projectClaim(
          await lifecycleCall(() =>
            owner.purgeOrganizationMemoryClaim({
              agentId: params.agentId,
              claimId: textParam(params.request, "claimId"),
              reason: textParam(params.request, "reason"),
              purgedAt: params.now,
            }),
          ),
        ),
      };
    default:
      return { handled: false };
  }
}
