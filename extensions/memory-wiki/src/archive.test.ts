import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  deleteMemoryWikiAttachment,
  listMemoryWikiArchive,
  putMemoryWikiAttachment,
  readMemoryWikiArchive,
} from "./archive.js";
import { compileMemoryWikiVault } from "./compile.js";
import { registerMemoryWikiGatewayMethods } from "./gateway.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const harness = createMemoryWikiTestHarness();
async function vault() {
  const result = await harness.createVault({ initialize: true });
  return {
    ...result,
    config: {
      ...result.config,
      agentId: "owner",
      vault: { ...result.config.vault, scope: "agent" as const },
    },
  };
}

describe("Personal Wiki source transfer", () => {
  it("stops attachment browse at its I/O budget before reading the next oversized file", async () => {
    const { rootDir, config } = await vault();
    for (let i = 0; i < 9; i++) {
      const file = await fs.open(path.join(rootDir, `_attachments/${i}.bin`), "w");
      try {
        await file.truncate((i === 8 ? 9 : 8) * 1024 * 1024);
      } finally {
        await file.close();
      }
    }
    const result = await listMemoryWikiArchive(config, "attachment");
    expect(result).toMatchObject({ totalBytes: 64 * 1024 * 1024, truncated: true });
    expect(result.entries).toHaveLength(8);
    // The ninth file exceeds the per-file read cap. Browse must stop before opening it.
    expect(result.entries.every((entry) => entry.size === 8 * 1024 * 1024)).toBe(true);
    await expect(listMemoryWikiArchive(config)).rejects.toThrow();
  });
  it("exports byte-exact sources and attachments while excluding generated indexes and external files", async () => {
    const { rootDir, config } = await vault();
    const source = "---\ntitle: Exact\n---\n\nOriginal\r\n  spacing\r\n";
    await fs.writeFile(path.join(rootDir, "concepts/exact.md"), source);
    await fs.writeFile(path.join(rootDir, "outside-not-a-page.txt"), "not a Wiki artifact");
    await compileMemoryWikiVault(config);
    const attachment = await putMemoryWikiAttachment({
      config,
      path: "diagram.bin",
      contentBase64: Buffer.from([0, 1, 255, 13]).toString("base64"),
    });
    const manifest = await listMemoryWikiArchive(config);
    expect(manifest.truncated).toBe(false);
    expect(manifest.entries.map((entry) => entry.path)).toEqual([
      "_attachments/diagram.bin",
      "concepts/exact.md",
      "inbox.md",
    ]);
    const page = manifest.entries.find((entry) => entry.path === "concepts/exact.md")!;
    const first = await readMemoryWikiArchive({
      config,
      path: page.path,
      expectedRevision: page.revision,
      length: 7,
    });
    const second = await readMemoryWikiArchive({
      config,
      path: page.path,
      expectedRevision: page.revision,
      offset: first.nextOffset!,
    });
    expect(
      Buffer.concat([
        Buffer.from(first.contentBase64, "base64"),
        Buffer.from(second.contentBase64, "base64"),
      ]).toString(),
    ).toBe(source);
    expect(second.nextOffset).toBeNull();
    expect((await listMemoryWikiArchive(config, "attachment")).entries).toEqual([
      expect.objectContaining(attachment),
    ]);
    await fs.writeFile(path.join(rootDir, page.path), "changed");
    await expect(
      readMemoryWikiArchive({ config, path: page.path, expectedRevision: page.revision }),
    ).rejects.toThrow("changed");
  });

  it("requires exact revision for replacing/deleting attachments and rejects path escape", async () => {
    const { config } = await vault();
    const first = await putMemoryWikiAttachment({
      config,
      path: "diagram.bin",
      contentBase64: "AA==",
    });
    await expect(
      putMemoryWikiAttachment({ config, path: "diagram.bin", contentBase64: "AQ==" }),
    ).rejects.toThrow();
    await expect(
      putMemoryWikiAttachment({
        config,
        path: "diagram.bin",
        contentBase64: "AQ==",
        expectedRevision: "a".repeat(64),
      }),
    ).rejects.toThrow("changed");
    const next = await putMemoryWikiAttachment({
      config,
      path: "diagram.bin",
      contentBase64: "AQ==",
      expectedRevision: first.revision,
    });
    await expect(
      deleteMemoryWikiAttachment({ config, path: next.path, expectedRevision: first.revision }),
    ).rejects.toThrow("changed");
    expect(
      await deleteMemoryWikiAttachment({
        config,
        path: next.path,
        expectedRevision: next.revision,
      }),
    ).toEqual({ deleted: true, path: next.path });
    for (const filePath of [
      "../secret",
      "x/../../secret",
      "/absolute",
      "x\\secret",
      "x:stream",
      "x\u0000y",
      "x\u001fy",
    ]) {
      await expect(
        putMemoryWikiAttachment({ config, path: filePath, contentBase64: "AA==" }),
      ).rejects.toThrow("canonical");
    }
    await expect(
      readMemoryWikiArchive({
        config,
        path: ".openclaw-wiki/log.jsonl",
        expectedRevision: first.revision,
      }),
    ).rejects.toThrow("Only Wiki");
    await expect(
      readMemoryWikiArchive({
        config,
        path: "concepts/a.md",
        expectedRevision: first.revision,
        length: 196609,
      }),
    ).rejects.toThrow("bounded");
  });

  it("registers bounded artifact RPCs with read/write permissions and preserves source hashes", async () => {
    const { config } = await vault();
    const { api, registerGatewayMethod } = harness.createPluginApi();
    registerMemoryWikiGatewayMethods({ api, config, resolveConfig: () => config });
    const methods = new Map(
      registerGatewayMethod.mock.calls.map(([name, handler, options]) => [
        name,
        { handler, options },
      ]),
    );
    expect(methods.get("wiki.archive.manifest")?.options).toEqual({ scope: "operator.read" });
    expect(methods.get("wiki.attachment.put")?.options).toEqual({ scope: "operator.write" });
    const respond = vi.fn();
    await methods.get("wiki.attachment.put")!.handler({
      params: { agentId: "owner", path: "original.bin", contentBase64: "AP8=" },
      respond,
    });
    expect(respond.mock.calls[0]?.[0]).toBe(true);
    const saved = respond.mock.calls[0]![1];
    respond.mockClear();
    await methods.get("wiki.archive.read")!.handler({
      params: { agentId: "owner", path: saved.path, expectedRevision: saved.revision, length: 1 },
      respond,
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        contentBase64: "AA==",
        nextOffset: 1,
        totalBytes: 2,
        revision: saved.revision,
      }),
    );
    respond.mockClear();
    await methods.get("wiki.archive.read")!.handler({
      params: { path: saved.path, expectedRevision: saved.revision, length: 196609 },
      respond,
    });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it("rejects hardlinked attachments rather than exporting outside-vault data", async () => {
    const { rootDir, config } = await vault();
    const outside = await harness.createTempDir("wiki-external-");
    await fs.writeFile(path.join(outside, "private.bin"), "private");
    await fs.link(
      path.join(outside, "private.bin"),
      path.join(rootDir, "_attachments/private.bin"),
    );
    await expect(listMemoryWikiArchive(config)).rejects.toThrow();
  });
});
