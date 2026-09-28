import type { IncomingMessage, ServerResponse } from "node:http";
import { readPlatformClawSessionCookie } from "./browser-auth-http.js";
import type { BrowserAuthService } from "./browser-auth-service.js";
import { sendBrowserJson } from "./browser-http-shared.js";
import {
  ControlPlaneAuthorizationError,
  ControlPlaneConflictError,
  ControlPlaneNotFoundError,
  ControlPlaneStateError,
} from "./contracts.js";
import { KNOWLEDGE_VAULT_LIMITS } from "./knowledge-vault-contracts.js";
import type { KnowledgeVaultService } from "./knowledge-vault-service.js";

async function readBytes(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) {
      throw new ControlPlaneStateError("Upload exceeds the permitted size");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function download(res: ServerResponse, content: Buffer, name: string, type: string): void {
  res.statusCode = 200;
  res.setHeader("Content-Type", type);
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.setHeader("Content-Length", content.length);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(content);
}

export async function handleKnowledgeVaultHttp(
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    vaultService?: KnowledgeVaultService;
    authService: BrowserAuthService;
  },
  isMutationOriginAllowed: (req: IncomingMessage) => boolean,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://platformclaw.internal");
  if (!options.vaultService || !url.pathname.startsWith("/platformclaw/vaults/")) {
    return false;
  }
  const method = req.method;
  const mutation = method === "POST" || method === "PUT";
  if (mutation && !isMutationOriginAllowed(req)) {
    sendBrowserJson(res, 403, { error: "Origin denied" });
    return true;
  }
  const token = readPlatformClawSessionCookie(req);
  const auth = token ? await options.authService.authenticateToken(token) : undefined;
  if (auth?.status !== "active") {
    sendBrowserJson(res, 401, { error: "Sign in again" });
    return true;
  }
  const vaults = options.vaultService.store.vaults;
  const userId = auth.user.id;
  try {
    const allowedQuery = url.pathname.endsWith("/attachment")
      ? ["vaultId", "path", "expectedRevision"]
      : ["vaultId"];
    for (const key of url.searchParams.keys()) {
      if (!allowedQuery.includes(key) || url.searchParams.getAll(key).length !== 1) {
        throw new ControlPlaneStateError("Invalid query parameter");
      }
    }
    const vaultId = url.searchParams.get("vaultId") ?? "";
    if (url.pathname === "/platformclaw/vaults/import" && method === "POST") {
      if (url.searchParams.size) {
        throw new ControlPlaneStateError("Import creates a new vault; merging is not supported");
      }
      const content = await readBytes(req, KNOWLEDGE_VAULT_LIMITS.archiveBytes);
      const result = await vaults.importVault({ userId, archive: content, ownerCanExport: true });
      sendBrowserJson(res, 201, result);
    } else if (url.pathname === "/platformclaw/vaults/export" && method === "GET") {
      vaults.requireExport(userId, vaultId);
      const content = await vaults.exportVault({ userId, vaultId });
      // Export has awaited compression; revalidate revocation before releasing bytes.
      vaults.requireExport(userId, vaultId);
      download(res, content, "knowledge-vault.zip", "application/zip");
    } else if (
      url.pathname === "/platformclaw/vaults/attachment" &&
      (method === "GET" || method === "PUT")
    ) {
      const path = url.searchParams.get("path") ?? "";
      if (method === "GET") {
        const file = vaults.downloadAttachment({ userId, vaultId, path });
        download(res, file.content, path.split("/").at(-1)!, "application/octet-stream");
      } else {
        const access = vaults.snapshot({ userId, vaultId }).selected;
        if (!access?.vault.canEdit) {
          throw new ControlPlaneAuthorizationError("Editor permission required");
        }
        const revision = url.searchParams.get("expectedRevision");
        if (
          revision !== null &&
          (!/^\d+$/u.test(revision) ||
            !Number.isSafeInteger(Number(revision)) ||
            Number(revision) < 1)
        ) {
          throw new ControlPlaneStateError("Invalid expectedRevision");
        }
        const content = await readBytes(req, KNOWLEDGE_VAULT_LIMITS.attachmentBytes);
        vaults.uploadAttachment({
          userId,
          vaultId,
          path,
          content,
          mediaType: "application/octet-stream",
          ...(revision === null ? {} : { expectedRevision: Number(revision) }),
        });
        sendBrowserJson(res, 200, { ok: true });
      }
    } else {
      sendBrowserJson(res, 405, { error: "Unsupported vault action" });
    }
  } catch (error) {
    if (
      error instanceof ControlPlaneAuthorizationError ||
      error instanceof ControlPlaneNotFoundError
    ) {
      sendBrowserJson(res, 403, { error: error.message });
    } else if (
      error instanceof ControlPlaneStateError ||
      error instanceof ControlPlaneConflictError
    ) {
      sendBrowserJson(res, 409, { error: error.message });
    } else {
      sendBrowserJson(res, 500, { error: "Vault operation failed; retry or rebuild the index" });
    }
  }
  return true;
}
