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
    throw new BrowserGatewayProxyError("method-not-allowed", "Wiki Hub unavailable");
  }
  const { service, request, access, method } = params;
  const vaults = service.store.vaults;
  const userId = access.user.id;
  const field = (key: string, max?: number, allowEmpty?: boolean) =>
    stringField(request, key, max, allowEmpty);
  try {
    let result: unknown;
    if (method === "platformclaw.vault.snapshot") {
      result = await service.snapshot({
        userId,
        ...(request.vaultId === undefined ? {} : { vaultId: field("vaultId") }),
      });
    } else if (method === "platformclaw.vault.connection.set") {
      if (typeof request.connected !== "boolean") {
        throw new ControlPlaneStateError("connected must be a boolean");
      }
      result = await service.setConnection({
        userId,
        vaultId: field("vaultId"),
        connected: request.connected,
      });
    } else if (method === "platformclaw.vault.create") {
      result = vaults.createVault({
        userId,
        name: field("name", 160),
        description: request.description === undefined ? "" : field("description", 2000, true),
      });
    } else if (method === "platformclaw.vault.rename") {
      result = vaults.renameVault({ userId, vaultId: field("vaultId"), name: field("name", 160) });
    } else if (method === "platformclaw.vault.delete") {
      result = vaults.deleteVault({ userId, vaultId: field("vaultId") });
    } else if (method === "platformclaw.vault.publish") {
      result = await service.publish({
        userId,
        agentId: access.binding.agentId,
        lookup: field("lookup"),
        targetVaultId: field("targetVaultId"),
        ...(request.path === undefined ? {} : { path: field("path") }),
        expectedRevision: field("expectedRevision", 64),
        ...(request.title === undefined ? {} : { title: field("title", 240) }),
        ...(request.content === undefined ? {} : { content: field("content", 1024 * 1024, true) }),
      });
    } else if (
      method === "platformclaw.vault.access.cancel" ||
      method === "platformclaw.vault.access.decide"
    ) {
      const decision = method.endsWith(".cancel") ? "cancel" : request.decision;
      if (decision !== "cancel" && decision !== "approve" && decision !== "reject") {
        throw new ControlPlaneStateError("Choose approve or reject");
      }
      if (method.endsWith(".decide") && decision === "cancel") {
        throw new ControlPlaneStateError("Choose approve or reject");
      }
      result = vaults.decideAccess({ userId, requestId: field("requestId"), decision });
    } else {
      const vaultId = field("vaultId");
      if (method === "platformclaw.vault.document.get") {
        result = await service.readDocument({ userId, vaultId, documentId: field("documentId") });
      } else if (method === "platformclaw.vault.document.targets") {
        result = await service.documentTargets({
          userId,
          vaultId,
          query: field("query", 160, true),
        });
      } else if (method === "platformclaw.vault.document.delete") {
        if (
          !(
            typeof request.expectedRevision === "number" &&
            Number.isSafeInteger(request.expectedRevision) &&
            request.expectedRevision > 0
          ) &&
          !(
            typeof request.expectedRevision === "string" &&
            /^[a-f0-9]{64}$/u.test(request.expectedRevision)
          )
        ) {
          throw new ControlPlaneStateError("Read the document before deleting");
        }
        result = await service.deleteDocument({
          userId,
          vaultId,
          documentId: field("documentId"),
          expectedRevision: request.expectedRevision as number | string,
        });
      } else if (
        method === "platformclaw.vault.document.save" ||
        method === "platformclaw.vault.document.preview"
      ) {
        if (
          request.expectedRevision !== undefined &&
          !(
            typeof request.expectedRevision === "string" &&
            /^[a-f0-9]{64}$/u.test(request.expectedRevision)
          ) &&
          (!Number.isSafeInteger(request.expectedRevision) ||
            (request.expectedRevision as number) < 1)
        ) {
          throw new ControlPlaneStateError("expectedRevision must be a source revision");
        }
        const document = {
          userId,
          vaultId,
          ...(request.title === undefined ? {} : { title: field("title", 240) }),
          ...(request.logicalPath === undefined ? {} : { logicalPath: field("logicalPath") }),
          ...(request.filename === undefined ? {} : { filename: field("filename") }),
          content: field("content", 1024 * 1024, true),
          ...(request.documentId === undefined ? {} : { documentId: field("documentId") }),
          ...(request.expectedRevision === undefined
            ? {}
            : { expectedRevision: request.expectedRevision as number | string }),
        };
        result =
          method === "platformclaw.vault.document.preview"
            ? service.previewDocument(document)
            : await service.saveDocument(document);
      } else if (method === "platformclaw.vault.member.set") {
        if (!["reader", "editor", "owner"].includes(String(request.role))) {
          throw new ControlPlaneStateError("A Reader, Editor or Owner role is required");
        }
        result = vaults.setMember({
          userId,
          vaultId,
          accountId: field("accountId", 160),
          role: request.role as "reader" | "editor" | "owner",
        });
      } else if (method === "platformclaw.vault.member.remove") {
        result = vaults.removeMember({ userId, vaultId, memberUserId: field("userId") });
      } else if (method === "platformclaw.vault.targets.search") {
        if (request.kind !== "user" && request.kind !== "organization") {
          throw new ControlPlaneStateError("Choose user or organization");
        }
        result = vaults.searchGrantTargets({
          userId,
          vaultId,
          kind: request.kind,
          query: field("query", 160, true),
        });
      } else if (method === "platformclaw.vault.owner.recover") {
        result = vaults.recoverOwner({ userId, vaultId, accountId: field("accountId", 160) });
      } else if (method === "platformclaw.vault.grant.set") {
        if (request.role !== "reader" && request.role !== "editor" && request.role !== "owner") {
          throw new ControlPlaneStateError("Choose Reader, Editor or Owner");
        }
        result = vaults.setOrganizationGrant({
          userId,
          vaultId,
          scopeId: field("scopeId"),
          role: request.role,
        });
      } else if (method === "platformclaw.vault.grant.remove") {
        result = vaults.removeOrganizationGrant({ userId, vaultId, scopeId: field("scopeId") });
      } else if (method === "platformclaw.vault.access.request") {
        if (request.role !== "reader" && request.role !== "editor") {
          throw new ControlPlaneStateError("Request Reader or Editor");
        }
        result = vaults.requestAccess({
          userId,
          vaultId,
          role: request.role,
          reason: request.reason === undefined ? undefined : field("reason", 1000, true),
        });
      } else if (method === "platformclaw.vault.rebuild") {
        result = await service.rebuild({
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
