import {
  BrowserGatewayProxyError,
  type BrowserGatewayAccess,
} from "./browser-gateway-contracts.js";
import { isKnowledgeVaultRpc } from "./browser-gateway-vault-policy.js";
import {
  ControlPlaneAuthorizationError,
  ControlPlaneConflictError,
  ControlPlaneNotFoundError,
  ControlPlaneStateError,
} from "./contracts.js";
import type { KnowledgeVaultService } from "./knowledge-vault-service.js";

function stringField(
  request: Record<string, unknown>,
  key: string,
  max = 512,
  allowEmpty = false,
): string {
  const value = request[key];
  if (typeof value !== "string" || value.length > max || (!allowEmpty && !value.trim())) {
    throw new ControlPlaneStateError(`${key} must be a string of at most ${max} characters`);
  }
  return value;
}

export async function requestBrowserKnowledgeVault(params: {
  service?: KnowledgeVaultService;
  access: BrowserGatewayAccess;
  method: string;
  request: Record<string, unknown>;
}): Promise<{ handled: false } | { handled: true; result: unknown }> {
  if (!isKnowledgeVaultRpc(params.method)) {
    return { handled: false };
  }
  if (!params.service) {
    throw new BrowserGatewayProxyError("method-not-allowed", "Memory Hub unavailable");
  }
  const { service, request, access, method } = params;
  const vaults = service.store.vaults;
  const userId = access.user.id;
  const field = (key: string, max?: number, allowEmpty?: boolean) =>
    stringField(request, key, max, allowEmpty);
  try {
    let result: unknown;
    if (method === "platformclaw.vault.snapshot") {
      result = service.snapshot({
        userId,
        ...(request.vaultId === undefined ? {} : { vaultId: field("vaultId") }),
      });
    } else if (method === "platformclaw.vault.connection.set") {
      if (typeof request.connected !== "boolean") {
        throw new ControlPlaneStateError("connected must be a boolean");
      }
      result = service.setConnection({
        userId,
        vaultId: field("vaultId"),
        connected: request.connected,
      });
    } else if (method === "platformclaw.vault.create") {
      result = vaults.createVault({
        userId,
        name: field("name", 160),
        ownerCanExport: true,
        description: request.description === undefined ? "" : field("description", 2000, true),
      });
    } else if (method === "platformclaw.vault.publish") {
      result = await service.publish({
        userId,
        agentId: access.binding.agentId,
        lookup: field("lookup"),
        targetVaultId: field("targetVaultId"),
        path: field("path"),
        expectedRevision: field("expectedRevision", 64),
      });
    } else {
      const vaultId = field("vaultId");
      if (method === "platformclaw.vault.document.get") {
        result = vaults.readDocument({ userId, vaultId, documentId: field("documentId") });
      } else if (method === "platformclaw.vault.document.save") {
        if (
          request.expectedRevision !== undefined &&
          (!Number.isSafeInteger(request.expectedRevision) ||
            (request.expectedRevision as number) < 1)
        ) {
          throw new ControlPlaneStateError("expectedRevision must be a positive integer");
        }
        result = vaults.saveDocument({
          userId,
          vaultId,
          title: field("title", 240),
          logicalPath: field("logicalPath"),
          content: field("content", 1024 * 1024, true),
          ...(request.documentId === undefined ? {} : { documentId: field("documentId") }),
          ...(request.expectedRevision === undefined
            ? {}
            : { expectedRevision: request.expectedRevision as number }),
        });
      } else if (method === "platformclaw.vault.member.set") {
        if (
          !["reader", "editor", "owner"].includes(String(request.role)) ||
          typeof request.canExport !== "boolean"
        ) {
          throw new ControlPlaneStateError(
            "A Reader, Editor or Owner role and export permission are required",
          );
        }
        result = vaults.setMember({
          userId,
          vaultId,
          accountId: field("accountId", 160),
          role: request.role as "reader" | "editor" | "owner",
          canExport: request.canExport,
        });
      } else if (method === "platformclaw.vault.member.remove") {
        result = vaults.removeMember({ userId, vaultId, memberUserId: field("userId") });
      } else if (method === "platformclaw.vault.rebuild") {
        result = vaults.rebuild({
          userId,
          vaultId,
          ...(request.documentId === undefined ? {} : { documentId: field("documentId") }),
        });
      }
    }
    return { handled: true, result: result ?? { ok: true } };
  } catch (error) {
    if (
      error instanceof ControlPlaneAuthorizationError ||
      error instanceof ControlPlaneNotFoundError
    ) {
      throw new BrowserGatewayProxyError("method-not-allowed", error.message);
    }
    if (error instanceof ControlPlaneStateError || error instanceof ControlPlaneConflictError) {
      throw new BrowserGatewayProxyError("invalid-params", error.message);
    }
    throw error;
  }
}
