import { createHash } from "node:crypto";
import { FsSafeError, root } from "openclaw/plugin-sdk/security-runtime";
import { compileMemoryWikiVault, isGeneratedMemoryWikiPage } from "./compile.js";
import { invalidateMemoryWikiCompiledCache } from "./compiled-cache.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { withMemoryWikiVaultMutation } from "./mutation-coordinator.js";
import {
  readMemoryWikiSourceSyncState,
  setImportedSourceEntry,
  writeMemoryWikiSourceSyncState,
} from "./source-sync-state.js";

export class MemoryWikiDeleteValidationError extends Error {}

/** Delete a confirmed Wiki artifact; its underlying imported source remains intact. */
export async function deleteMemoryWikiPage(params: {
  config: ResolvedMemoryWikiConfig;
  path: string;
  expectedContentHash: string;
}): Promise<{ path: string; deleted: true; indexesRefreshed: boolean }> {
  const { config, path, expectedContentHash } = params;
  if (
    typeof path !== "string" ||
    path.length > 1024 ||
    !/^(entities|concepts|syntheses|sources|reports)\/.+\.md$/u.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..") ||
    path.split("").some((char) => char.charCodeAt(0) < 32 || char === "\\" || char === ":") ||
    typeof expectedContentHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(expectedContentHash)
  ) {
    throw new MemoryWikiDeleteValidationError("Reload a Wiki page before deleting it.");
  }
  if (isGeneratedMemoryWikiPage(path)) {
    throw new MemoryWikiDeleteValidationError(
      "This Wiki page is generated. Delete its underlying pages instead.",
    );
  }
  return await withMemoryWikiVaultMutation(config.vault.path, async () => {
    const vault = await root(config.vault.path);
    let exists = true;
    try {
      const raw = await vault.readBytes(path, { maxBytes: 256 * 1024 });
      if (createHash("sha256").update(raw).digest("hex") !== expectedContentHash) {
        throw new MemoryWikiDeleteValidationError("Wiki page changed. Reload it before deleting.");
      }
    } catch (error) {
      if (!(error instanceof FsSafeError && error.code === "not-found")) {
        throw error;
      }
      exists = false;
    }
    const state = await readMemoryWikiSourceSyncState(config.vault.path);
    for (const [syncKey, entry] of Object.entries(state.entries)) {
      if (entry.pagePath === path && !entry.deleted) {
        setImportedSourceEntry({ syncKey, state, entry: { ...entry, deleted: true } });
      }
    }
    // Persist suppression before removal so a process restart cannot recreate the page.
    // Retain tombstones when sources disappear: updating or re-adding raw data is not restore.
    await writeMemoryWikiSourceSyncState(config.vault.path, state);
    await invalidateMemoryWikiCompiledCache(config);
    if (exists) {
      await vault.remove(path);
    }
    let indexesRefreshed = false;
    try {
      // The coordinator permits nested compile calls; source sync queues after this mutation.
      await compileMemoryWikiVault(config);
      indexesRefreshed = true;
    } catch {
      // Deletion committed. Retrying this same request repairs indexes without deleting new content.
    }
    return { path, deleted: true, indexesRefreshed };
  });
}
