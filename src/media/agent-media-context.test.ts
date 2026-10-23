import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  resolveAllowedManagedMediaPath,
  resolveSandboxedMediaSource,
} from "../agents/sandbox-paths.js";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";
import {
  getAgentMediaDir,
  getCurrentAgentMediaId,
  withAgentMediaContext,
} from "./agent-media-context.js";
import { readLocalMediaFile } from "./local-media-access.js";
import {
  getAgentScopedMediaLocalRootsForSources,
  getDefaultMediaLocalRoots,
} from "./local-roots.js";
import { resolveInboundMediaReference } from "./media-reference.js";
import {
  cleanOldMedia,
  deleteMediaBuffer,
  readMediaBuffer,
  saveMediaBuffer,
  saveMediaSource,
  saveMediaStream,
  writePlaybackTranscodeCache,
} from "./store.js";

describe("Agent media ownership", () => {
  let home: TempHomeEnv;
  beforeAll(async () => {
    home = await createTempHomeEnv("openclaw-agent-media-");
  });
  afterAll(async () => {
    await home.restore();
  });

  it("isolates interleaved producers, references, and deletion without changing unscoped ingestion", async () => {
    const sharedDir = getAgentMediaDir();
    const legacy = await saveMediaBuffer(Buffer.from("legacy"), "text/plain");
    const produce = (owner: string) =>
      withAgentMediaContext(owner, async () => {
        await Promise.resolve();
        expect(getCurrentAgentMediaId()).toBe(owner.toLowerCase());
        const saved = await saveMediaBuffer(Buffer.from(owner), "text/plain");
        expect(path.dirname(saved.path)).toBe(
          path.join(sharedDir, "agents", owner.toLowerCase(), "inbound"),
        );
        const ref = await resolveInboundMediaReference(`media://inbound/${saved.id}`);
        expect(ref?.physicalPath).toBe(await fs.realpath(saved.path));
        return saved;
      });
    const [one, two] = await Promise.all([produce("One"), produce("Two")]);
    expect(getCurrentAgentMediaId()).toBeUndefined();
    await withAgentMediaContext("two", async () => {
      await expect(readMediaBuffer(one.id)).rejects.toThrow("does not resolve");
      await expect(deleteMediaBuffer(one.id)).rejects.toThrow();
      await expect(resolveInboundMediaReference(`media://inbound/${legacy.id}`)).rejects.toThrow();
      await expect(resolveInboundMediaReference(one.path)).rejects.toThrow("another or unscoped");
      expect((await readMediaBuffer(two.id)).buffer.toString()).toBe("Two");
      await withAgentMediaContext("one", async () => {
        expect((await readMediaBuffer(one.id)).buffer.toString()).toBe("One");
      });
      expect(getCurrentAgentMediaId()).toBe("two");
    });
    expect((await readMediaBuffer(legacy.id)).buffer.toString()).toBe("legacy");
  });

  it("publishes buffer, stream, and copied files under the producer's owner", async () => {
    await withAgentMediaContext("writer", async () => {
      const stream = await saveMediaStream(Readable.from([Buffer.from("stream")]), "text/plain");
      const copy = await saveMediaSource(stream.path, undefined, "outbound");
      expect(copy.path.startsWith(`${getAgentMediaDir()}${path.sep}`)).toBe(true);
      expect((await readMediaBuffer(copy.id, "outbound")).buffer.toString()).toBe("stream");
    });
  });

  it("rejects foreign store sources despite broad explicit roots and managed-path shortcuts", async () => {
    const sharedRoot = getAgentMediaDir();
    const foreign = await withAgentMediaContext(
      "foreign",
      async () => await saveMediaBuffer(Buffer.from("foreign"), "text/plain", "tool-file-transfer"),
    );
    await withAgentMediaContext("reader", async () => {
      const own = await saveMediaBuffer(Buffer.from("own"), "text/plain", "outbound");
      expect(await resolveAllowedManagedMediaPath(own.path)).toBe(own.path);
      expect(await resolveAllowedManagedMediaPath(foreign.path)).toBeUndefined();
      await expect(saveMediaSource(foreign.path)).rejects.toThrow("another or unscoped");
      for (const roots of [[sharedRoot], "any"] as const) {
        await expect(
          readLocalMediaFile(foreign.path, roots, { maxBytes: 100 }),
        ).rejects.toMatchObject({ code: "path-not-allowed" });
      }
      await expect(
        resolveSandboxedMediaSource({
          media: foreign.path,
          sandboxRoot: path.join(home.home, "work"),
        }),
      ).rejects.toThrow("escapes sandbox");
      const roots = getAgentScopedMediaLocalRootsForSources({
        cfg: { agents: { entries: { reader: { workspace: path.join(home.home, "work") } } } },
        agentId: "reader",
        mediaSources: [foreign.path, path.join(sharedRoot, "outbound", "legacy.txt")],
      });
      expect(roots).toEqual([getAgentMediaDir(), path.join(home.home, "work")]);
      expect(getDefaultMediaLocalRoots()).toEqual([getAgentMediaDir()]);
    });
  });

  it.runIf(process.platform !== "win32")(
    "rejects owner-directory links into another store",
    async () => {
      const other = await withAgentMediaContext(
        "link-target",
        async () => await saveMediaBuffer(Buffer.from("private"), "text/plain"),
      );
      const alias = getAgentMediaDir("linked");
      await fs.symlink(getAgentMediaDir("link-target"), alias, "dir");
      await withAgentMediaContext("linked", async () => {
        await expect(readMediaBuffer(other.id)).rejects.toThrow("does not resolve");
        await expect(saveMediaBuffer(Buffer.from("overwrite"), "text/plain")).rejects.toThrow();
        await expect(saveMediaStream(Readable.from(["overwrite"]), "text/plain")).rejects.toThrow(
          "another or unscoped",
        );
        await expect(
          readLocalMediaFile(path.join(alias, "inbound", other.id), [alias], { maxBytes: 100 }),
        ).rejects.toMatchObject({ code: "path-not-allowed" });
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "checks physical ownership when the complete media root is a symlink",
    async () => {
      const shared = getAgentMediaDir();
      const physical = `${shared}-physical`;
      await fs.mkdir(shared, { recursive: true });
      await fs.rename(shared, physical);
      await fs.symlink(physical, shared, "dir");
      try {
        const foreign = await withAgentMediaContext("physical-foreign", () =>
          saveMediaBuffer(Buffer.from("foreign bytes"), "text/plain"),
        );
        const physicalSource = await fs.realpath(foreign.path);
        await withAgentMediaContext("physical-reader", async () => {
          await expect(
            readLocalMediaFile(physicalSource, "any", { maxBytes: 100 }),
          ).rejects.toMatchObject({ code: "path-not-allowed" });
          await expect(saveMediaSource(physicalSource)).rejects.toThrow("another or unscoped");
        });
      } finally {
        await fs.unlink(shared);
        await fs.rename(physical, shared);
      }
    },
  );

  it("retains durable outgoing originals during the unscoped recursive TTL sweep", async () => {
    const kept = await withAgentMediaContext(
      "retained",
      async () => await saveMediaBuffer(Buffer.from("durable"), "text/plain", "outgoing/originals"),
    );
    const expired = await withAgentMediaContext(
      "retained",
      async () => await saveMediaBuffer(Buffer.from("temporary"), "text/plain", "inbound"),
    );
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(kept.path, old, old);
    await fs.utimes(expired.path, old, old);
    await cleanOldMedia(1_000, { recursive: true });
    await expect(fs.readFile(kept.path, "utf8")).resolves.toBe("durable");
    await expect(fs.stat(expired.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps one shared playback cache budget across isolated owners", async () => {
    const old = await withAgentMediaContext(
      "cache-one",
      async () =>
        await writePlaybackTranscodeCache({
          buffer: Buffer.from("old"),
          fileName: "old.mp3",
          maxBytes: 1024,
          tempPrefix: ".test-",
        }),
    );
    await fs.truncate(old, 512 * 1024 * 1024);
    const past = new Date(Date.now() - 60_000);
    await fs.utimes(old, past, past);
    const current = await withAgentMediaContext(
      "cache-two",
      async () =>
        await writePlaybackTranscodeCache({
          buffer: Buffer.from("current"),
          fileName: "current.mp3",
          maxBytes: 1024,
          tempPrefix: ".test-",
        }),
    );
    await expect(fs.stat(old)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(current, "utf8")).resolves.toBe("current");
  });
});
