import { Buffer } from "node:buffer";
import { crc32 } from "node:zlib";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import JSZip from "jszip";
import { ControlPlaneStateError } from "./contracts.js";
import { knowledgeVaultPath } from "./knowledge-vault-compiler.js";
import { KNOWLEDGE_VAULT_LIMITS } from "./knowledge-vault-contracts.js";

export type KnowledgeVaultArchive = {
  name: string;
  description: string;
  documents: Array<{ title: string; logicalPath: string; content: string }>;
  attachments: Array<{ path: string; mediaType: string; content: Buffer }>;
};

function invalid(): never {
  throw new ControlPlaneStateError(
    "Invalid Vault ZIP; use a Vault export with valid metadata and bounded files",
  );
}

export function requireKnowledgeVaultMediaType(value: string): string {
  if (value.length > 120 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/iu.test(value)) {
    throw new ControlPlaneStateError(
      "Attachment media type must be a MIME type without parameters",
    );
  }
  return value.toLowerCase();
}

export async function encodeKnowledgeVaultArchive(data: KnowledgeVaultArchive): Promise<Buffer> {
  const zip = new JSZip();
  const metadata = {
    format: "platformclaw-vault",
    version: 1,
    name: data.name,
    description: data.description,
    documents: data.documents.map(({ title, logicalPath }) => ({ title, logicalPath })),
    attachments: data.attachments.map(({ path, mediaType }) => ({ path, mediaType })),
  };
  zip.file("vault.json", JSON.stringify(metadata, null, 2));
  let expanded = Buffer.byteLength(JSON.stringify(metadata));
  for (const doc of data.documents) {
    expanded += Buffer.byteLength(doc.content);
    zip.file(`documents/${doc.logicalPath}`, doc.content, { createFolders: false });
  }
  for (const attachment of data.attachments) {
    expanded += attachment.content.length;
    zip.file(`attachments/${attachment.path}`, attachment.content, { createFolders: false });
  }
  if (
    expanded > KNOWLEDGE_VAULT_LIMITS.expandedBytes ||
    data.documents.length + data.attachments.length + 1 > KNOWLEDGE_VAULT_LIMITS.files
  ) {
    throw new ControlPlaneStateError(
      "Vault exceeds ZIP export limits (64 MiB expanded, 1000 files)",
    );
  }
  const result = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    platform: "UNIX",
  });
  if (result.length > KNOWLEDGE_VAULT_LIMITS.archiveBytes) {
    throw new ControlPlaneStateError("Vault exceeds 32 MiB ZIP download limit");
  }
  return result;
}

async function readEntry(entry: JSZip.JSZipObject, budget: { bytes: number }): Promise<Buffer> {
  // JSZip returns readable-stream v2, whose contract is events rather than async iteration.
  return await new Promise<Buffer>((resolve, reject) => {
    const stream = entry.nodeStream("nodebuffer") as NodeJS.ReadableStream & { destroy(): void };
    const parts: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      stream.pause();
      stream.destroy();
      reject(error);
    };
    stream.on("data", (raw: Buffer | string) => {
      if (settled) {
        return;
      }
      const part = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      bytes += part.length;
      budget.bytes += part.length;
      if (
        bytes > KNOWLEDGE_VAULT_LIMITS.attachmentBytes ||
        budget.bytes > KNOWLEDGE_VAULT_LIMITS.expandedBytes
      ) {
        fail(new ControlPlaneStateError("Vault ZIP exceeds expanded size limits"));
        return;
      }
      parts.push(part);
    });
    stream.once("error", fail);
    stream.once("end", () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(Buffer.concat(parts, bytes));
    });
  });
}

/** Inspect names before JSZip collapses duplicate central-directory entries. */
function validateArchiveNames(bytes: Buffer): Map<string, { crc: number; bytes: number }> {
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65557); at--) {
    if (
      bytes.readUInt32LE(at) === 0x06054b50 &&
      at + 22 + bytes.readUInt16LE(at + 20) === bytes.length
    ) {
      end = at;
      break;
    }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) {
    invalid();
  }
  const count = bytes.readUInt16LE(end + 10);
  let at = bytes.readUInt32LE(end + 16);
  const size = bytes.readUInt32LE(end + 12);
  if (
    count > KNOWLEDGE_VAULT_LIMITS.files ||
    count !== bytes.readUInt16LE(end + 8) ||
    at + size !== end
  ) {
    invalid();
  }
  const names = new Map<string, { crc: number; bytes: number }>();
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || bytes.readUInt32LE(at) !== 0x02014b50) {
      invalid();
    }
    const length = bytes.readUInt16LE(at + 28);
    const next = at + 46 + length + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
    if (next > end) {
      invalid();
    }
    const name = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(at + 46, at + 46 + length),
    );
    if (names.has(name)) {
      invalid();
    }
    names.set(name, { crc: bytes.readUInt32LE(at + 16), bytes: bytes.readUInt32LE(at + 24) });
    at = next;
  }
  if (at !== end) {
    invalid();
  }
  return names;
}

function text(value: unknown, max: number, empty = false): string {
  if (typeof value !== "string" || (!empty && !value.trim()) || value.length > max) {
    invalid();
  }
  return value;
}

export async function decodeKnowledgeVaultArchive(bytes: Buffer): Promise<KnowledgeVaultArchive> {
  if (bytes.length < 22 || bytes.length > KNOWLEDGE_VAULT_LIMITS.archiveBytes) {
    invalid();
  }
  const headers = validateArchiveNames(bytes);
  const zip = await JSZip.loadAsync(bytes, { createFolders: false });
  const entries = Object.values(zip.files);
  if (entries.length > KNOWLEDGE_VAULT_LIMITS.files) {
    invalid();
  }
  const files = new Map<string, Buffer>();
  const budget = { bytes: 0 };
  for (const entry of entries) {
    const original = entry.unsafeOriginalName ?? entry.name;
    knowledgeVaultPath(entry.dir ? original.replace(/\/$/u, "") : original);
    const permissions =
      typeof entry.unixPermissions === "string"
        ? Number.parseInt(entry.unixPermissions, 8)
        : entry.unixPermissions;
    const kind = (permissions ?? 0) & 0o170000;
    if (
      original !== entry.name ||
      (kind !== 0 && kind !== 0o100000 && !(entry.dir && kind === 0o040000))
    ) {
      invalid();
    }
    if (!entry.dir) {
      const content = await readEntry(entry, budget);
      const header = headers.get(entry.name);
      if (!header || header.bytes !== content.length || header.crc !== crc32(content)) {
        invalid();
      }
      files.set(entry.name, content);
    }
  }
  const manifest = files.get("vault.json");
  if (!manifest || manifest.length > KNOWLEDGE_VAULT_LIMITS.documentBytes) {
    invalid();
  }
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifest));
  if (
    !isRecord(value) ||
    value.format !== "platformclaw-vault" ||
    value.version !== 1 ||
    !Array.isArray(value.documents) ||
    !Array.isArray(value.attachments)
  ) {
    invalid();
  }
  const consumed = new Set(["vault.json"]);
  const take = (name: string): Buffer => {
    const content = files.get(name);
    if (!content || consumed.has(name)) {
      invalid();
    }
    consumed.add(name);
    return content;
  };
  const documents = value.documents.map((raw: unknown) => {
    if (!isRecord(raw)) {
      invalid();
    }
    const logicalPath = knowledgeVaultPath(text(raw.logicalPath, 512));
    if (!/\.md$/iu.test(logicalPath)) {
      invalid();
    }
    const content = take(`documents/${logicalPath}`);
    if (content.length > KNOWLEDGE_VAULT_LIMITS.documentBytes) {
      invalid();
    }
    return {
      title: text(raw.title, 240),
      logicalPath,
      content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content),
    };
  });
  const attachments = value.attachments.map((raw: unknown) => {
    if (!isRecord(raw)) {
      invalid();
    }
    const path = knowledgeVaultPath(text(raw.path, 512));
    return {
      path,
      mediaType: requireKnowledgeVaultMediaType(text(raw.mediaType, 120)),
      content: take(`attachments/${path}`),
    };
  });
  if (consumed.size !== files.size) {
    invalid();
  }
  const sourceBytes =
    documents.reduce((sum, doc) => sum + Buffer.byteLength(doc.content), 0) +
    attachments.reduce((sum, file) => sum + file.content.length, 0);
  if (sourceBytes > KNOWLEDGE_VAULT_LIMITS.archiveBytes - KNOWLEDGE_VAULT_LIMITS.documentBytes) {
    invalid();
  }
  // Membership, identifiers and all derived data are deliberately absent from the import contract.
  return {
    name: text(value.name, 160),
    description: text(value.description, 2000, true),
    documents,
    attachments,
  };
}
