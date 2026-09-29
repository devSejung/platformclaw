import { Buffer } from "node:buffer";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { BrowserGatewayRpc } from "./browser-gateway-contracts.js";
import { ControlPlaneStateError } from "./contracts.js";
import {
  encodeKnowledgeVaultArchive,
  requireKnowledgeVaultMediaType,
} from "./knowledge-vault-archive.js";
import { knowledgeVaultPath } from "./knowledge-vault-compiler.js";
import { KNOWLEDGE_VAULT_LIMITS } from "./knowledge-vault-contracts.js";
import { resolveKnowledgeVaultDocumentMetadata } from "./knowledge-vault-document.js";

type Entry = {
  path: string;
  kind: "document" | "attachment";
  size: number;
  revision: string;
  title?: string;
  mediaType?: string;
};
const invalid = (): never => {
  throw new ControlPlaneStateError("Personal Wiki file response is invalid; refresh and retry");
};

/** The private source owner walks files; Control only packages bounded, revision-pinned artifacts. */
export class PersonalKnowledgeFiles {
  constructor(private readonly gateway: BrowserGatewayRpc) {}
  async manifest(
    agentId: string,
    kind?: "attachment",
  ): Promise<{ entries: Entry[]; truncated: boolean }> {
    const result = await this.gateway.request("wiki.archive.manifest", {
      agentId,
      ...(kind ? { kind } : {}),
    });
    if (
      !isRecord(result) ||
      !Array.isArray(result.entries) ||
      result.entries.length >= KNOWLEDGE_VAULT_LIMITS.files
    ) {
      return invalid();
    }
    let bytes = 0;
    const paths = new Set<string>();
    const entries = result.entries.map((raw): Entry => {
      if (
        !isRecord(raw) ||
        typeof raw.path !== "string" ||
        (raw.kind !== "document" && raw.kind !== "attachment") ||
        typeof raw.size !== "number" ||
        !Number.isSafeInteger(raw.size) ||
        raw.size < 0 ||
        typeof raw.revision !== "string" ||
        !/^[a-f0-9]{64}$/u.test(raw.revision)
      ) {
        return invalid();
      }
      const path = knowledgeVaultPath(raw.path);
      if (
        paths.has(path) ||
        (raw.kind === "attachment" && !path.startsWith("_attachments/")) ||
        (!kind &&
          raw.size >
            (raw.kind === "document"
              ? KNOWLEDGE_VAULT_LIMITS.documentBytes
              : KNOWLEDGE_VAULT_LIMITS.attachmentBytes))
      ) {
        return invalid();
      }
      bytes += raw.size;
      if (!kind && bytes > KNOWLEDGE_VAULT_LIMITS.expandedBytes) {
        return invalid();
      }
      paths.add(path);
      return {
        path,
        kind: raw.kind,
        size: raw.size,
        revision: raw.revision,
        ...(typeof raw.title === "string" ? { title: raw.title.slice(0, 240) } : {}),
        ...(typeof raw.mediaType === "string"
          ? { mediaType: requireKnowledgeVaultMediaType(raw.mediaType) }
          : {}),
      };
    });
    return { entries, truncated: result.truncated === true };
  }
  async read(agentId: string, entry: Entry): Promise<Buffer> {
    const parts: Buffer[] = [];
    let offset = 0;
    do {
      const result = await this.gateway.request("wiki.archive.read", {
        agentId,
        path: entry.path,
        expectedRevision: entry.revision,
        offset,
        length: 196608,
      });
      if (
        !isRecord(result) ||
        typeof result.contentBase64 !== "string" ||
        result.contentBase64.length > 262144 ||
        result.totalBytes !== entry.size ||
        result.path !== entry.path ||
        result.revision !== entry.revision
      ) {
        return invalid();
      }
      const chunk = Buffer.from(result.contentBase64, "base64");
      if (
        chunk.toString("base64") !== result.contentBase64 ||
        offset + chunk.length > entry.size ||
        (chunk.length === 0 && offset < entry.size)
      ) {
        return invalid();
      }
      parts.push(chunk);
      offset += chunk.length;
      if (result.nextOffset !== (offset < entry.size ? offset : null)) {
        return invalid();
      }
    } while (offset < entry.size);
    return Buffer.concat(parts, entry.size);
  }
  async export(agentId: string): Promise<Buffer> {
    const { entries, truncated } = await this.manifest(agentId);
    if (truncated) {
      throw new ControlPlaneStateError(
        "Personal Wiki exceeds the complete ZIP export bounds; no partial archive was created",
      );
    }
    const documents: Array<{ title: string; logicalPath: string; content: string }> = [];
    const attachments: Array<{ path: string; mediaType: string; content: Buffer }> = [];
    for (const entry of entries) {
      const bytes = await this.read(agentId, entry);
      if (entry.kind === "attachment") {
        attachments.push({
          path: entry.path,
          mediaType: entry.mediaType ?? "application/octet-stream",
          content: bytes,
        });
      } else {
        const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
        const title =
          entry.title ??
          resolveKnowledgeVaultDocumentMetadata({
            userId: "",
            vaultId: "",
            filename: entry.path,
            content,
          }).title;
        documents.push({ title, logicalPath: entry.path, content });
      }
    }
    return encodeKnowledgeVaultArchive({
      name: "Personal Wiki",
      description: "Explicit export of private Wiki sources",
      documents,
      attachments,
    });
  }
  async download(agentId: string, path: string) {
    const entry = (await this.manifest(agentId, "attachment")).entries.find(
      (item) => item.path === path && item.kind === "attachment",
    );
    if (!entry) {
      throw new ControlPlaneStateError("Personal Wiki attachment unavailable");
    }
    if (entry.size > KNOWLEDGE_VAULT_LIMITS.attachmentBytes) {
      throw new ControlPlaneStateError("Attachment exceeds 8 MiB download bound");
    }
    return {
      content: await this.read(agentId, entry),
      revision: entry.revision,
      mediaType: entry.mediaType ?? "application/octet-stream",
    };
  }
  async upload(
    agentId: string,
    params: { path: string; content: Buffer; expectedRevision?: number | string },
  ) {
    if (params.content.length > KNOWLEDGE_VAULT_LIMITS.attachmentBytes) {
      throw new ControlPlaneStateError("Attachment exceeds 8 MiB");
    }
    const path = knowledgeVaultPath(params.path).replace(/^_attachments\//u, "");
    if (
      params.expectedRevision !== undefined &&
      (typeof params.expectedRevision !== "string" ||
        !/^[a-f0-9]{64}$/u.test(params.expectedRevision))
    ) {
      throw new ControlPlaneStateError("Reload the attachment before replacing it");
    }
    const result = await this.gateway.request("wiki.attachment.put", {
      agentId,
      path,
      contentBase64: params.content.toString("base64"),
      ...(params.expectedRevision === undefined
        ? {}
        : { expectedRevision: params.expectedRevision }),
    });
    if (
      !isRecord(result) ||
      result.path !== `_attachments/${path}` ||
      result.size !== params.content.length ||
      typeof result.revision !== "string" ||
      !/^[a-f0-9]{64}$/u.test(result.revision)
    ) {
      return invalid();
    }
    return result;
  }

  async delete(agentId: string, params: { path: string; expectedRevision: string }) {
    const path = knowledgeVaultPath(params.path).replace(/^_attachments\//u, "");
    const artifactPath = `_attachments/${path}`;
    if (!/^[a-f0-9]{64}$/u.test(params.expectedRevision)) {
      throw new ControlPlaneStateError("Reload the attachment before deleting it");
    }
    const result = await this.gateway.request("wiki.attachment.delete", {
      agentId,
      path: artifactPath,
      expectedRevision: params.expectedRevision,
    });
    if (!isRecord(result) || result.path !== artifactPath || result.deleted !== true) {
      return invalid();
    }
    return result;
  }
}
