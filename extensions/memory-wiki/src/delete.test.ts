import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compileMemoryWikiVault } from "./compile.js";
import { deleteMemoryWikiPage } from "./delete.js";
import { withMemoryWikiVaultMutation } from "./mutation-coordinator.js";
import { getMemoryWikiPage } from "./query.js";
import { writeImportedSourcePage } from "./source-page-shared.js";
import {
  pruneImportedSourceEntries,
  readMemoryWikiSourceSyncState,
  writeMemoryWikiSourceSyncState,
} from "./source-sync-state.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const removeFailure = vi.hoisted(() => ({ enabled: false }));
vi.mock("openclaw/plugin-sdk/security-runtime", async (original) => {
  const actual = await original<typeof import("openclaw/plugin-sdk/security-runtime")>();
  return {
    ...actual,
    root: async (...args: Parameters<typeof actual.root>) => {
      const vault = await actual.root(...args);
      const remove = vault.remove.bind(vault);
      vault.remove = async (...removeArgs: Parameters<typeof vault.remove>) => {
        if (removeFailure.enabled) {
          throw new Error("EACCES /private/runtime/vault");
        }
        return await remove(...removeArgs);
      };
      return vault;
    },
  };
});

vi.mock("./compile.js", async (original) => {
  const actual = await original<typeof import("./compile.js")>();
  return { ...actual, compileMemoryWikiVault: vi.fn(actual.compileMemoryWikiVault) };
});
const { createVault } = createMemoryWikiTestHarness();
const hash = (raw: string) => createHash("sha256").update(raw).digest("hex");
const raw = "---\npageType: concept\ntitle: Confirmed\n---\n# Confirmed\nPrivate notes\n";
afterEach(() => {
  removeFailure.enabled = false;
  vi.clearAllMocks();
});

describe("Wiki artifact deletion", () => {
  it("keeps the page and rejects when removal fails, then permits a retry", async () => {
    const { rootDir, config } = await createVault({ initialize: true });
    const pagePath = "concepts/confirmed.md";
    await fs.writeFile(path.join(rootDir, pagePath), raw);
    const request = { config, path: pagePath, expectedContentHash: hash(raw) };
    removeFailure.enabled = true;
    await expect(deleteMemoryWikiPage(request)).rejects.toThrow("EACCES");
    expect(await fs.readFile(path.join(rootDir, pagePath), "utf8")).toBe(raw);
    expect(compileMemoryWikiVault).not.toHaveBeenCalled();
    removeFailure.enabled = false;
    await expect(deleteMemoryWikiPage(request)).resolves.toMatchObject({ deleted: true });
  });
  it("pins the full raw page even for an excerpt and withholds deletion from shared vaults", async () => {
    const { rootDir, config } = await createVault({ initialize: true });
    await fs.writeFile(path.join(rootDir, "concepts/confirmed.md"), raw);
    const personalConfig = {
      ...config,
      agentId: "main",
      vault: { ...config.vault, scope: "agent" as const },
    };
    const page = await getMemoryWikiPage({
      config: personalConfig,
      appConfig: { agents: { list: [{ id: "main" }] } },
      agentId: "main",
      lookup: "concepts/confirmed.md",
      lineCount: 1,
    });
    expect(page).toMatchObject({ contentHash: hash(raw), truncated: true });
    const shared = await getMemoryWikiPage({
      config: { ...config, vault: { ...config.vault, scope: "global" } },
      lookup: "concepts/confirmed.md",
    });
    expect(shared).toMatchObject({ deletionUnavailableReason: "shared-vault" });
    expect(shared).not.toHaveProperty("contentHash");
  });

  it("removes a native page, preserves another vault, and repairs a failed compile on retry", async () => {
    const { rootDir, config } = await createVault({ initialize: true });
    const other = await createVault({ initialize: true });
    const pagePath = "concepts/confirmed.md";
    await fs.writeFile(path.join(rootDir, pagePath), raw);
    await fs.writeFile(path.join(other.rootDir, pagePath), raw);
    vi.mocked(compileMemoryWikiVault).mockRejectedValueOnce(new Error("compile offline"));
    const request = { config, path: pagePath, expectedContentHash: hash(raw) };
    await expect(deleteMemoryWikiPage(request)).resolves.toEqual({
      path: pagePath,
      deleted: true,
      indexesRefreshed: false,
    });
    await expect(fs.access(path.join(rootDir, pagePath))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(other.rootDir, pagePath), "utf8")).resolves.toBe(raw);
    await expect(deleteMemoryWikiPage(request)).resolves.toMatchObject({ indexesRefreshed: true });
    await fs.writeFile(path.join(rootDir, pagePath), "new content");
    await expect(deleteMemoryWikiPage(request)).rejects.toThrow("changed");
    await expect(fs.readFile(path.join(rootDir, pagePath), "utf8")).resolves.toBe("new content");
  });

  it.each([
    "../concepts/a.md",
    "concepts/../a.md",
    "concepts//a.md",
    "index.md",
    "concepts/a.md:stream",
    "concepts\\a.md",
  ])("rejects an unsafe artifact path %s", async (pagePath) => {
    const { config } = await createVault({ initialize: true });
    await expect(
      deleteMemoryWikiPage({ config, path: pagePath, expectedContentHash: hash(raw) }),
    ).rejects.toThrow("Reload");
  });

  it.each(["reports/open-questions.md", "concepts/index.md"])(
    "preserves compiler-owned page %s",
    async (pagePath) => {
      const { rootDir, config } = await createVault({ initialize: true });
      await fs.writeFile(path.join(rootDir, pagePath), raw);
      await expect(
        deleteMemoryWikiPage({ config, path: pagePath, expectedContentHash: hash(raw) }),
      ).rejects.toThrow("generated");
      expect(await fs.readFile(path.join(rootDir, pagePath), "utf8")).toBe(raw);
    },
  );

  it.runIf(process.platform !== "win32")("preserves a symlink target", async () => {
    const { rootDir, config } = await createVault({ initialize: true });
    const other = await createVault({ initialize: true });
    const target = path.join(other.rootDir, "concepts/target.md");
    await fs.writeFile(target, raw);
    await fs.symlink(target, path.join(rootDir, "concepts/link.md"));
    await expect(
      deleteMemoryWikiPage({ config, path: "concepts/link.md", expectedContentHash: hash(raw) }),
    ).rejects.toThrow();
    await expect(fs.readFile(target, "utf8")).resolves.toBe(raw);
  });

  it("queues behind an earlier import and keeps deletion suppressed across source changes and re-add", async () => {
    const { rootDir, config } = await createVault({ initialize: true });
    const sourcePath = path.join(rootDir, "original.md");
    await fs.writeFile(sourcePath, "Original raw memory");
    const pagePath = "sources/imported.md";
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const importPage = async (stamp: number) => {
      const state = await readMemoryWikiSourceSyncState(rootDir);
      const result = await writeImportedSourcePage({
        vaultRoot: rootDir,
        syncKey: sourcePath,
        sourcePath,
        sourceUpdatedAtMs: stamp,
        sourceSize: stamp,
        renderFingerprint: String(stamp),
        pagePath,
        group: "bridge",
        state,
        buildRendered: () => raw,
      });
      await writeMemoryWikiSourceSyncState(rootDir, state);
      return result;
    };
    const oldImport = withMemoryWikiVaultMutation(rootDir, async () => {
      started();
      await gate;
      await importPage(1);
    });
    await ready;
    const deletion = deleteMemoryWikiPage({
      config,
      path: pagePath,
      expectedContentHash: hash(raw),
    });
    release();
    await oldImport;
    await expect(deletion).resolves.toMatchObject({ deleted: true });
    await fs.writeFile(sourcePath, "Updated original memory");
    expect(await importPage(2)).toMatchObject({ changed: false });
    await fs.rm(sourcePath);
    const state = await readMemoryWikiSourceSyncState(rootDir);
    await pruneImportedSourceEntries({
      vaultRoot: rootDir,
      group: "bridge",
      activeKeys: new Set(),
      state,
    });
    await writeMemoryWikiSourceSyncState(rootDir, state);
    await fs.writeFile(sourcePath, "Re-added memory");
    expect(await importPage(3)).toMatchObject({ changed: false });
    await expect(fs.access(path.join(rootDir, pagePath))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(sourcePath, "utf8")).toBe("Re-added memory");
    expect((await readMemoryWikiSourceSyncState(rootDir)).entries[sourcePath]?.deleted).toBe(true);
  });
});
