import { writeFile } from "node:fs/promises";
import path from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { validateZipArchiveFile } from "./zip-archive-validator.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const markdown = Buffer.from(
  "---\nname: demo-skill\ndescription: Demo\nversion: 1.0.0\n---\nBody\n",
);
const limits = {
  archiveBytes: 1024 * 1024,
  expandedBytes: 1024,
  entryBytes: 768,
  files: 100,
  retainedEntryBytes: 512,
};

type FileSpec = {
  name?: string;
  content?: Buffer;
  method?: 0 | 8;
  signed?: boolean;
  descriptor?: boolean;
  localExtra?: Buffer;
  centralExtra?: Buffer;
  compressedSuffix?: Buffer;
  truncateDeflate?: boolean;
};

// Independent ZIP records let each malformed field reach the real validator;
// no ZIP reader repairs or normalizes the attack fixture before validation.
function archive(specs: FileSpec[] = [{}]) {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  const records: Array<{ local: number; data: number; descriptor: number; central: number }> = [];
  let localOffset = 0;
  let centralSize = 0;
  for (const spec of specs) {
    const name = Buffer.from(spec.name ?? "SKILL.md");
    const content = spec.content ?? markdown;
    const method = content.length === 0 ? 0 : (spec.method ?? 8);
    const compressed = method === 8 ? deflateRawSync(content) : content;
    const data = Buffer.concat([
      spec.truncateDeflate ? compressed.subarray(0, -1) : compressed,
      spec.compressedSuffix ?? Buffer.alloc(0),
    ]);
    const descriptor = spec.descriptor !== false;
    const flags = 0x0800 | (descriptor ? 8 : 0);
    const crc = crc32(content);
    const localExtra = spec.localExtra ?? Buffer.alloc(0);
    const centralExtra = spec.centralExtra ?? Buffer.alloc(0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(descriptor ? 0 : crc, 14);
    local.writeUInt32LE(descriptor ? 0 : data.length, 18);
    local.writeUInt32LE(descriptor ? 0 : content.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    const trailer = Buffer.alloc(descriptor ? (spec.signed === false ? 12 : 16) : 0);
    if (descriptor) {
      const offset = trailer.length === 16 ? 4 : 0;
      if (offset) {
        trailer.writeUInt32LE(0x08074b50);
      }
      trailer.writeUInt32LE(crc, offset);
      trailer.writeUInt32LE(data.length, offset + 4);
      trailer.writeUInt32LE(content.length, offset + 8);
    }
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(0x0314, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(flags, 8);
    directory.writeUInt16LE(method, 10);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(content.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt16LE(centralExtra.length, 30);
    directory.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    directory.writeUInt32LE(localOffset, 42);
    records.push({
      local: localOffset,
      data: localOffset + local.length + name.length + localExtra.length,
      descriptor: localOffset + local.length + name.length + localExtra.length + data.length,
      central: centralSize,
    });
    const entry = Buffer.concat([local, name, localExtra, data, trailer]);
    const directoryEntry = Buffer.concat([directory, name, centralExtra]);
    locals.push(entry);
    central.push(directoryEntry);
    localOffset += entry.length;
    centralSize += directoryEntry.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(specs.length, 8);
  end.writeUInt16LE(specs.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(localOffset, 16);
  return {
    bytes: Buffer.concat([...locals, ...central, end]),
    records: records.map((record) => ({
      local: record.local,
      data: record.data,
      descriptor: record.descriptor,
      central: localOffset + record.central,
    })),
    centralOffset: localOffset,
  };
}

async function validate(bytes: Buffer, budget = limits) {
  const file = path.join(tempDirs.make("skillhub-descriptors-"), "archive.zip");
  await writeFile(file, bytes);
  return await validateZipArchiveFile(file, bytes.length, budget);
}

function resizeDescriptor(delta: number) {
  const { bytes, centralOffset } = archive();
  const resized = Buffer.concat([
    bytes.subarray(0, centralOffset + Math.min(0, delta)),
    Buffer.alloc(Math.max(0, delta)),
    bytes.subarray(centralOffset),
  ]);
  resized.writeUInt32LE(centralOffset + delta, resized.length - 6);
  return resized;
}

describe("ZIP data descriptor integrity", () => {
  it.each([
    [0, true],
    [0, false],
    [8, true],
    [8, false],
  ] as const)(
    "accepts method %s with signed=%s descriptors, empty files and Unicode paths",
    async (method, signed) => {
      const { bytes } = archive([
        { method, signed },
        { name: "empty.txt", content: Buffer.alloc(0), method, signed },
        { name: "한글.txt", content: Buffer.from("hello"), method, signed },
      ]);
      await expect(validate(bytes)).resolves.toEqual({ skillMarkdown: markdown });
    },
  );

  it("accepts mixed streamed and fixed local headers and reordered central records", async () => {
    const value = archive([
      {},
      { name: "a.txt", content: Buffer.from("hello"), descriptor: false },
    ]);
    const first = value.records[0]!;
    const second = value.records[1]!;
    const bytes = Buffer.concat([
      value.bytes.subarray(0, value.centralOffset),
      value.bytes.subarray(second.central, -22),
      value.bytes.subarray(first.central, second.central),
      value.bytes.subarray(-22),
    ]);
    await expect(validate(bytes)).resolves.toEqual({ skillMarkdown: markdown });
  });

  it("accepts an unsigned descriptor whose CRC equals the optional signature", async () => {
    const content = Buffer.from("ac0a7ad5", "hex");
    expect(crc32(content)).toBe(0x08074b50);
    const { bytes } = archive([{}, { name: "signature-crc.bin", content, signed: false }]);
    await expect(validate(bytes)).resolves.toEqual({ skillMarkdown: markdown });
  });

  it.each([
    ["signature", 0],
    ["checksum", 4],
    ["compressed size", 8],
    ["expanded size", 12],
  ] as const)("rejects a mismatched descriptor %s", async (_label, offset) => {
    const { bytes, records } = archive();
    const position = records[0]!.descriptor + offset;
    bytes.writeUInt32LE((bytes.readUInt32LE(position) ^ 1) >>> 0, position);
    await expect(validate(bytes)).rejects.toThrow("ZIP data descriptor size or checksum");
  });

  it.each([-16, -15, -1, 1, 8])(
    "rejects a missing, truncated or oversized descriptor (delta=%s)",
    async (delta) => {
      await expect(validate(resizeDescriptor(delta))).rejects.toThrow("ZIP data descriptor");
    },
  );

  it.each(["local", "central"] as const)(
    "rejects ZIP64 %s extra fields without size sentinels",
    async (field) => {
      const extra = Buffer.alloc(20);
      extra.writeUInt16LE(1);
      extra.writeUInt16LE(16, 2);
      const { bytes } = archive([
        field === "local" ? { localExtra: extra } : { centralExtra: extra },
      ]);
      await expect(validate(bytes)).rejects.toThrow("ZIP64 archives are not supported");
    },
  );

  it.each(["local", "central"] as const)("rejects truncated %s extra fields", async (field) => {
    const extra = Buffer.from([2, 0, 8, 0]);
    const { bytes } = archive([
      field === "local" ? { localExtra: extra } : { centralExtra: extra },
    ]);
    await expect(validate(bytes)).rejects.toThrow("extra field is truncated");
  });

  it("rejects a descriptor overlapping the next local record", async () => {
    const { bytes, records } = archive([{}, { name: "a.txt", content: Buffer.from("hello") }]);
    bytes.writeUInt32LE(records[0]!.descriptor + 8, records[1]!.central + 42);
    await expect(validate(bytes)).rejects.toThrow("ZIP data descriptor");
  });

  it.each(["flags", "checksum", "compressed", "expanded"] as const)(
    "rejects mismatched local %s before reading payload",
    async (field) => {
      const { bytes } = archive();
      if (field === "flags") {
        bytes.writeUInt16LE(0x800, 6);
      } else {
        bytes.writeUInt32LE(1, field === "checksum" ? 14 : field === "compressed" ? 18 : 22);
      }
      await expect(validate(bytes)).rejects.toThrow("ZIP local entry");
    },
  );

  it("rejects encryption while supporting the descriptor flag", async () => {
    const { bytes, records } = archive();
    bytes.writeUInt16LE(0x809, 6);
    bytes.writeUInt16LE(0x809, records[0]!.central + 8);
    await expect(validate(bytes)).rejects.toThrow("unsupported feature");
  });

  it("checks streamed content CRC independently of matching central and descriptor claims", async () => {
    const { bytes, records } = archive([{ method: 0 }]);
    bytes[records[0]!.data] = bytes[records[0]!.data]! ^ 1;
    await expect(validate(bytes)).rejects.toThrow("ZIP entry size or checksum");
  });

  it("rejects compressed trailing junk even with matching declared sizes and content CRC", async () => {
    const { bytes } = archive([{ compressedSuffix: Buffer.from("hidden") }]);
    await expect(validate(bytes)).rejects.toThrow("ZIP entry size or checksum");
  });

  it("rejects truncated deflate content with a structurally correct descriptor", async () => {
    const { bytes } = archive([{ truncateDeflate: true }]);
    await expect(validate(bytes)).rejects.toThrow("compression stream is invalid");
  });

  it("enforces expanded and retained markdown budgets for descriptor archives", async () => {
    const { bytes } = archive();
    await expect(validate(bytes, { ...limits, expandedBytes: 8 })).rejects.toThrow("expands past");
    await expect(validate(bytes, { ...limits, retainedEntryBytes: 8 })).rejects.toThrow("SKILL.md");
  });
});
