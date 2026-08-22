import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { createInflateRaw } from "node:zlib";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_EOCD_BYTES = 65_557;
const MAX_CENTRAL_DIRECTORY_BYTES = 2 * 1024 * 1024;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

export class ZipArchiveValidationError extends Error {}

type ZipArchiveLimits = {
  archiveBytes: number;
  expandedBytes: number;
  entryBytes: number;
  files: number;
  retainedEntryBytes: number;
};

type Entry = {
  name: string;
  flags: number;
  method: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  directory: boolean;
  externalAttributes: number;
};

function invalid(message: string): never {
  throw new ZipArchiveValidationError(message);
}

function decodeName(bytes: Buffer): string {
  try {
    return UTF8.decode(bytes);
  } catch {
    return invalid("ZIP archive contains an invalid UTF-8 path");
  }
}

function validatePath(name: string, directory: boolean): void {
  const path = directory && name.endsWith("/") ? name.slice(0, -1) : name;
  if (
    !path ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.includes(":") ||
    path.startsWith("/") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    invalid("ZIP archive contains an unsafe path");
  }
}

function validateUnixType(entry: Entry): void {
  const mode = (entry.externalAttributes >>> 16) & 0xffff;
  const type = mode & 0o170000;
  if (type === 0 || type === 0o100000 || (entry.directory && type === 0o040000)) {
    return;
  }
  invalid(
    type === 0o120000
      ? "ZIP archive contains a symbolic link"
      : "ZIP archive contains an unsupported entry type",
  );
}

async function readAt(path: string, offset: number, length: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const bytes = Buffer.allocUnsafe(length);
    const result = await handle.read(bytes, 0, length, offset);
    if (result.bytesRead !== length) {
      invalid("ZIP archive is truncated");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function readCentralDirectory(
  path: string,
  archiveBytes: number,
): Promise<{
  entries: Entry[];
  centralOffset: number;
}> {
  const tailLength = Math.min(archiveBytes, MAX_EOCD_BYTES);
  const tail = await readAt(path, archiveBytes - tailLength, tailLength);
  let eocd = -1;
  for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) === EOCD_SIGNATURE) {
      const commentLength = tail.readUInt16LE(offset + 20);
      if (offset + 22 + commentLength === tail.length) {
        eocd = offset;
        break;
      }
    }
  }
  if (eocd < 0) {
    invalid("ZIP archive has no valid end record");
  }
  const disk = tail.readUInt16LE(eocd + 4);
  const centralDisk = tail.readUInt16LE(eocd + 6);
  const diskEntries = tail.readUInt16LE(eocd + 8);
  const entryCount = tail.readUInt16LE(eocd + 10);
  const centralSize = tail.readUInt32LE(eocd + 12);
  const centralOffset = tail.readUInt32LE(eocd + 16);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    diskEntries !== entryCount ||
    entryCount === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    invalid("multi-disk and ZIP64 archives are not supported");
  }
  if (
    centralSize > MAX_CENTRAL_DIRECTORY_BYTES ||
    centralOffset + centralSize > archiveBytes - tailLength + eocd
  ) {
    invalid("ZIP central directory is invalid");
  }
  const central = await readAt(path, centralOffset, centralSize);
  const entries: Entry[] = [];
  let offset = 0;
  while (offset < central.length) {
    if (offset + 46 > central.length || central.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      invalid("ZIP central directory entry is invalid");
    }
    const nameLength = central.readUInt16LE(offset + 28);
    const extraLength = central.readUInt16LE(offset + 30);
    const commentLength = central.readUInt16LE(offset + 32);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > central.length) {
      invalid("ZIP central directory entry is truncated");
    }
    const name = decodeName(central.subarray(offset + 46, offset + 46 + nameLength));
    const entry: Entry = {
      name,
      flags: central.readUInt16LE(offset + 8),
      method: central.readUInt16LE(offset + 10),
      crc32: central.readUInt32LE(offset + 16),
      compressedSize: central.readUInt32LE(offset + 20),
      uncompressedSize: central.readUInt32LE(offset + 24),
      externalAttributes: central.readUInt32LE(offset + 38),
      localOffset: central.readUInt32LE(offset + 42),
      directory: name.endsWith("/"),
    };
    if (
      (entry.flags & ~0x800) !== 0 ||
      entry.compressedSize === 0xffffffff ||
      entry.uncompressedSize === 0xffffffff ||
      entry.localOffset === 0xffffffff ||
      (entry.method !== 0 && entry.method !== 8)
    ) {
      invalid("ZIP archive uses an unsupported feature");
    }
    validatePath(entry.name, entry.directory);
    validateUnixType(entry);
    entries.push(entry);
    offset = next;
  }
  if (entries.length !== entryCount) {
    invalid("ZIP entry count does not match its end record");
  }
  return { entries, centralOffset };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function updateCrc(crc: number, bytes: Buffer): number {
  let value = crc;
  for (const byte of bytes) {
    value = CRC_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  }
  return value >>> 0;
}

async function inspectEntry(
  path: string,
  entry: Entry,
  centralOffset: number,
  limits: ZipArchiveLimits,
): Promise<{ rangeStart: number; rangeEnd: number; retained?: Buffer }> {
  const local = await readAt(path, entry.localOffset, 30);
  if (local.readUInt32LE(0) !== LOCAL_SIGNATURE) {
    invalid("ZIP local entry header is invalid");
  }
  const localFlags = local.readUInt16LE(6);
  const localMethod = local.readUInt16LE(8);
  const nameLength = local.readUInt16LE(26);
  const extraLength = local.readUInt16LE(28);
  if (localFlags !== entry.flags || localMethod !== entry.method) {
    invalid("ZIP local entry does not match its central record");
  }
  const localName = decodeName(await readAt(path, entry.localOffset + 30, nameLength));
  if (localName !== entry.name) {
    invalid("ZIP local entry path does not match its central record");
  }
  const dataStart = entry.localOffset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > centralOffset) {
    invalid("ZIP entry data overlaps its central directory");
  }
  if (entry.directory) {
    if (entry.compressedSize !== 0 || entry.uncompressedSize !== 0) {
      invalid("ZIP directory entry contains data");
    }
    return { rangeStart: entry.localOffset, rangeEnd: dataEnd };
  }
  if (entry.compressedSize === 0) {
    if (entry.uncompressedSize !== 0 || entry.crc32 !== 0) {
      invalid("ZIP empty entry size or checksum is invalid");
    }
    return {
      rangeStart: entry.localOffset,
      rangeEnd: dataEnd,
      ...(entry.name === "SKILL.md" ? { retained: Buffer.alloc(0) } : {}),
    };
  }
  const source = createReadStream(path, {
    start: dataStart,
    end: dataEnd - 1,
  });
  const output = entry.method === 8 ? source.pipe(createInflateRaw()) : source;
  const retained = entry.name === "SKILL.md" ? ([] as Buffer[]) : undefined;
  let bytes = 0;
  let crc = 0xffffffff;
  try {
    for await (const raw of output) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      bytes += chunk.byteLength;
      if (bytes > limits.entryBytes || (retained && bytes > limits.retainedEntryBytes)) {
        invalid(
          retained
            ? "ZIP archive contains an invalid SKILL.md"
            : "ZIP archive contains an oversized entry",
        );
      }
      crc = updateCrc(crc, chunk);
      retained?.push(chunk);
    }
  } catch (error) {
    if (error instanceof ZipArchiveValidationError) {
      throw error;
    }
    invalid("ZIP entry compression stream is invalid");
  } finally {
    source.destroy();
  }
  if (bytes !== entry.uncompressedSize || (crc ^ 0xffffffff) >>> 0 !== entry.crc32) {
    invalid("ZIP entry size or checksum is invalid");
  }
  return {
    rangeStart: entry.localOffset,
    rangeEnd: dataEnd,
    ...(retained ? { retained: Buffer.concat(retained, bytes) } : {}),
  };
}

export async function validateZipArchiveFile(
  path: string,
  archiveBytes: number,
  limits: ZipArchiveLimits,
): Promise<{ skillMarkdown: Buffer }> {
  if (archiveBytes < 22 || archiveBytes > limits.archiveBytes) {
    invalid("ZIP archive exceeds the configured size limit");
  }
  const { entries, centralOffset } = await readCentralDirectory(path, archiveBytes);
  const files = entries.filter((entry) => !entry.directory);
  if (files.length < 1 || files.length > limits.files) {
    invalid("ZIP archive contains too many files");
  }
  let expanded = 0;
  for (const entry of files) {
    if (entry.uncompressedSize > limits.entryBytes) {
      invalid("ZIP archive contains an oversized entry");
    }
    expanded += entry.uncompressedSize;
    if (expanded > limits.expandedBytes) {
      invalid("ZIP archive expands past the configured size limit");
    }
  }
  const ranges: Array<{ start: number; end: number }> = [];
  let skillMarkdown: Buffer | undefined;
  for (const entry of entries) {
    const inspected = await inspectEntry(path, entry, centralOffset, limits);
    if (
      ranges.some((range) => inspected.rangeStart < range.end && inspected.rangeEnd > range.start)
    ) {
      invalid("ZIP archive contains overlapping entries");
    }
    ranges.push({ start: inspected.rangeStart, end: inspected.rangeEnd });
    if (inspected.retained) {
      if (skillMarkdown) {
        invalid("ZIP archive contains duplicate SKILL.md entries");
      }
      skillMarkdown = inspected.retained;
    }
  }
  if (!skillMarkdown) {
    invalid("ZIP archive is missing SKILL.md");
  }
  return { skillMarkdown };
}
