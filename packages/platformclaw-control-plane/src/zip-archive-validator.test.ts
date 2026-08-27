import { writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { validateZipArchiveFile } from "./zip-archive-validator.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const limits = {
  archiveBytes: 1024 * 1024,
  expandedBytes: 1024,
  entryBytes: 768,
  files: 100,
  retainedEntryBytes: 512,
};

async function archiveFile(mutator?: (zip: JSZip) => void) {
  const zip = new JSZip();
  zip.file(
    "SKILL.md",
    "---\nname: demo-skill\ndescription: Demo\nversion: 1.0.0\n---\nInstructions\n",
  );
  mutator?.(zip);
  const bytes = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    platform: "UNIX",
  });
  const file = path.join(tempDirs.make("platformclaw-streaming-zip-"), "archive.zip");
  await writeFile(file, bytes);
  return { file, bytes };
}

describe("streaming ZIP archive validation", () => {
  it("retains only bounded SKILL.md while validating all entry CRCs", async () => {
    const { file, bytes } = await archiveFile((zip) => zip.file("helper.txt", "hello"));
    await expect(validateZipArchiveFile(file, bytes.byteLength, limits)).resolves.toMatchObject({
      skillMarkdown: expect.any(Buffer),
    });
  });

  it("accepts .env package files", async () => {
    const { file, bytes } = await archiveFile((zip) =>
      zip.file(".env.production", "RUNTIME_MODE=production"),
    );
    await expect(validateZipArchiveFile(file, bytes.byteLength, limits)).resolves.toMatchObject({
      skillMarkdown: expect.any(Buffer),
    });
  });

  it.each([
    ["path traversal", (zip: JSZip) => zip.file("../escape", "bad"), /unsafe path/u],
    [
      "symbolic link",
      (zip: JSZip) => zip.file("link", "target", { unixPermissions: 0o120777 }),
      /symbolic link/u,
    ],
    ["oversized entry", (zip: JSZip) => zip.file("large", "x".repeat(800)), /oversized/u],
    [
      "reserved runtime metadata",
      (zip: JSZip) => zip.file(".openclaw/source-origin.json", "{}"),
      /reserved path/u,
    ],
  ])("rejects %s without extracting to disk", async (_label, mutate, expected) => {
    const { file, bytes } = await archiveFile(mutate);
    await expect(validateZipArchiveFile(file, bytes.byteLength, limits)).rejects.toThrow(expected);
  });

  it("enforces regular-file and total-entry budgets separately", async () => {
    const files = await archiveFile((zip) => {
      zip.file("one.txt", "1");
      zip.file("two.txt", "2");
    });
    await expect(
      validateZipArchiveFile(files.file, files.bytes.byteLength, {
        ...limits,
        files: 2,
        entries: 100,
      }),
    ).rejects.toThrow("too many files");

    const directories = await archiveFile((zip) => {
      zip.folder("one");
      zip.folder("two");
    });
    await expect(
      validateZipArchiveFile(directories.file, directories.bytes.byteLength, {
        ...limits,
        files: 2,
        entries: 2,
      }),
    ).rejects.toThrow("too many entries");
  });
});
