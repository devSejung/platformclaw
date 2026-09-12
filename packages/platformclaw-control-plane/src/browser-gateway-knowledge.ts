import { BrowserGatewayProxyError } from "./browser-gateway-contracts.js";
import { ControlPlaneAuthorizationError, ControlPlaneStateError } from "./contracts.js";
import type { OrganizationKnowledgeService } from "./organization-knowledge-service.js";
import type { OrganizationKnowledgeHistoryQuery } from "./organization-memory-knowledge-contracts.js";
import type { SqliteControlPlaneStore } from "./sqlite-store.js";

function stringParam(request: Record<string, unknown>, key: string): string {
  const value = request[key];
  const maxChars = key === "proposedText" ? 8_000 : 2_000;
  if (typeof value !== "string" || !value.trim() || value.length > maxChars) {
    throw new BrowserGatewayProxyError(
      "invalid-params",
      `${key} must be a bounded nonempty string`,
    );
  }
  return value;
}

export async function requestBrowserOrganizationKnowledge(params: {
  store: SqliteControlPlaneStore | undefined;
  service: OrganizationKnowledgeService | undefined;
  agentId: string;
  method: string;
  request: Record<string, unknown>;
  now: number;
}): Promise<{ handled: false } | { handled: true; result: unknown }> {
  if (!params.method.startsWith("platformclaw.memory.knowledge.")) {
    return { handled: false };
  }
  if (!params.store || !params.service) {
    throw new BrowserGatewayProxyError(
      "method-not-allowed",
      "organization knowledge is unavailable",
    );
  }
  const { store, service, request, agentId } = params;
  try {
    if (params.method === "platformclaw.memory.knowledge.comparePromotion") {
      return {
        handled: true,
        result: await service.comparePromotion({
          agentId,
          requestId: stringParam(request, "requestId"),
        }),
      };
    }
    if (params.method === "platformclaw.memory.knowledge.snapshot") {
      const history: OrganizationKnowledgeHistoryQuery = {};
      if (request.historyDecision !== undefined) {
        if (request.historyDecision !== "reject") {
          throw new BrowserGatewayProxyError("invalid-params", "historyDecision must be reject");
        }
        history.historyDecision = "reject";
      }
      if (request.historyCursor !== undefined) {
        const cursor = request.historyCursor as { occurredAt?: unknown; id?: unknown } | null;
        if (
          !cursor ||
          typeof cursor !== "object" ||
          Array.isArray(cursor) ||
          !Number.isSafeInteger(cursor.occurredAt) ||
          (cursor.occurredAt as number) < 0 ||
          typeof cursor.id !== "string" ||
          !cursor.id ||
          cursor.id.length > 128
        ) {
          throw new BrowserGatewayProxyError(
            "invalid-params",
            "historyCursor must be a bounded review cursor",
          );
        }
        history.historyCursor = { occurredAt: cursor.occurredAt as number, id: cursor.id };
      }
      return {
        handled: true,
        result: await store.getOrganizationKnowledgeSnapshot({
          agentId,
          ...history,
          ...(request.scopeId === undefined ? {} : { scopeId: stringParam(request, "scopeId") }),
        }),
      };
    }
    const scopeId = stringParam(request, "scopeId");
    if (params.method === "platformclaw.memory.knowledge.generate") {
      if (request.force !== undefined && typeof request.force !== "boolean") {
        throw new BrowserGatewayProxyError("invalid-params", "force must be boolean");
      }
      return {
        handled: true,
        result: await service.generate({
          agentId,
          scopeId,
          requestId: stringParam(request, "requestId"),
          ...(request.force === undefined ? {} : { force: request.force as boolean }),
        }),
      };
    }
    if (params.method === "platformclaw.memory.knowledge.decide") {
      if (
        request.decision !== "approve" &&
        request.decision !== "reject" &&
        request.decision !== "keep"
      ) {
        throw new BrowserGatewayProxyError(
          "invalid-params",
          "decision must be approve, reject or keep",
        );
      }
      if (
        !Number.isSafeInteger(request.expectedRevision) ||
        (request.expectedRevision as number) < 0
      ) {
        throw new BrowserGatewayProxyError(
          "invalid-params",
          "expectedRevision must be nonnegative integer",
        );
      }
      return {
        handled: true,
        result: await store.decideOrganizationKnowledgeProposal({
          agentId,
          scopeId,
          proposalId: stringParam(request, "proposalId"),
          expectedRevision: request.expectedRevision as number,
          decision: request.decision,
          reason: stringParam(request, "reason"),
          now: params.now,
        }),
      };
    }
    if (params.method === "platformclaw.memory.knowledge.apply") {
      if (
        !Number.isSafeInteger(request.expectedRevision) ||
        (request.expectedRevision as number) < 0
      ) {
        throw new BrowserGatewayProxyError(
          "invalid-params",
          "expectedRevision must be nonnegative integer",
        );
      }
      return {
        handled: true,
        result: await store.applyOrganizationKnowledgeProposal({
          agentId,
          scopeId,
          proposalId: stringParam(request, "proposalId"),
          expectedRevision: request.expectedRevision as number,
          survivorClaimId: stringParam(request, "survivorClaimId"),
          proposedText: stringParam(request, "proposedText"),
          reason: stringParam(request, "reason"),
          now: params.now,
        }),
      };
    }
    throw new BrowserGatewayProxyError(
      "method-not-allowed",
      "this organization knowledge action is unavailable",
    );
  } catch (error) {
    if (error instanceof ControlPlaneAuthorizationError) {
      throw new BrowserGatewayProxyError("method-not-allowed", error.message);
    }
    if (error instanceof ControlPlaneStateError) {
      throw new BrowserGatewayProxyError("invalid-params", error.message);
    }
    throw error;
  }
}
