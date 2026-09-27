// Memory Wiki compiled cache ownership and persistence.
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { PluginBlobStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { WikiFreshnessLevel } from "./claim-health.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import type { WikiPageKind, WikiPageSummary, WikiRelationship } from "./markdown.js";

export const LEGACY_MEMORY_WIKI_COMPILED_CACHE_PATHS = [
  ".openclaw-wiki/cache/agent-digest.json",
  ".openclaw-wiki/cache/claims.jsonl",
] as const;

const COMPILED_CACHE_NAMESPACE = "compiled-cache";
const COMPILED_CACHE_MAX_ENTRIES = 256;
const COMPILED_CACHE_MAX_BYTES_PER_ENTRY = 100 * 1024 * 1024;
const COMPILED_CACHE_MAX_BYTES = 512 * 1024 * 1024;
const COMPILED_CACHE_VERSION = 2;

export type MemoryWikiCompiledDigestClaim = {
  id?: string;
  text: string;
  status: string;
  confidence?: number;
  freshnessLevel: WikiFreshnessLevel;
};

export type MemoryWikiCompiledDigestPage = {
  id?: string;
  title: string;
  kind: WikiPageKind;
  path: string;
  pageType?: string;
  entityType?: string;
  canonicalId?: string;
  aliases: string[];
  sourceIds: string[];
  questions: string[];
  contradictions: string[];
  privacyTier?: string;
  personCard?: WikiPageSummary["personCard"];
  bestUsedFor: string[];
  notEnoughFor: string[];
  relationshipCount: number;
  topRelationships: WikiRelationship[];
  claimCount: number;
  topClaims: MemoryWikiCompiledDigestClaim[];
};

export type MemoryWikiCompiledClaim = {
  id?: string;
  pageId?: string;
  pageTitle: string;
  pageKind: WikiPageKind;
  pagePath: string;
  pageType?: string;
  entityType?: string;
  canonicalId?: string;
  aliases?: string[];
  text: string;
  status?: string;
  confidence?: number;
  sourceIds?: string[];
  evidenceKinds?: string[];
  privacyTiers?: string[];
  freshnessLevel?: string;
  lastTouchedAt?: string;
};

export type MemoryWikiCompiledCacheSnapshot = {
  /** Immutable search input. Original files are never used to repair a failed index. */
  searchPages?: Array<{ relativePath: string; raw: string }>;
  digest: {
    claimCount: number;
    contradictionCount: number;
    pages: MemoryWikiCompiledDigestPage[];
  };
  claims: MemoryWikiCompiledClaim[];
};

type CompiledCacheMetadata = {
  version: typeof COMPILED_CACHE_VERSION;
  ownerId: string;
  vaultPath: string;
  vaultGeneration: string;
  publicationId: string;
  generation: string;
  encoding: "gzip-json";
};

type ActiveVault = {
  path: string;
  vaultGeneration: string;
  compiledCachePublicationId?: string;
  searchPublicationId?: string;
  reconciled: boolean;
};

type MemoryWikiCompiledCacheStore = {
  readSearch(config: ResolvedMemoryWikiConfig): Promise<MemoryWikiCompiledCacheSnapshot | null>;
  readFailure(config: ResolvedMemoryWikiConfig): Promise<MemoryWikiCompileFailure | null>;
  recordFailure(
    config: ResolvedMemoryWikiConfig,
    failure: MemoryWikiCompileFailure | null,
  ): Promise<void>;
  read(config: ResolvedMemoryWikiConfig): Promise<MemoryWikiCompiledCacheSnapshot | null>;
  write(
    config: ResolvedMemoryWikiConfig,
    snapshot: MemoryWikiCompiledCacheSnapshot,
    generation: string,
    publicationId: string,
  ): Promise<ActiveVault>;
  reconcile(
    config: ResolvedMemoryWikiConfig,
    loadDurableIdentity: () => Promise<{
      vaultGeneration: string | null;
      compiledCachePublicationId: string | null;
    }>,
  ): Promise<void>;
  delete(config: ResolvedMemoryWikiConfig): Promise<void>;
  deletePublication(config: ResolvedMemoryWikiConfig, publicationId: string): Promise<void>;
  deleteOwnersExcept(ownerIds: ReadonlySet<string>): Promise<number>;
};

export type MemoryWikiCompileFailure = {
  error: string;
  failedAt: number;
  nextRetryAt: number;
  attempts: number;
};

let configuredStore: MemoryWikiCompiledCacheStore | undefined;
const activeVaults = new Map<string, ActiveVault>();

export function resolveMemoryWikiCompiledCacheOwnerId(config: ResolvedMemoryWikiConfig): string {
  if (config.vault.scope === "global") {
    return "global";
  }
  const agentId = config.agentId?.trim();
  if (!agentId) {
    throw new Error("Memory Wiki agent-scoped compiled cache requires an agent owner.");
  }
  return `agent:${agentId}`;
}

function ownerKeyPrefix(ownerId: string): string {
  return `owner:${createHash("sha256").update(ownerId).digest("hex")}:publication:`;
}

function publicationKey(ownerId: string, publicationId: string): string {
  return `${ownerKeyPrefix(ownerId)}${createHash("sha256").update(publicationId).digest("hex")}`;
}

function isMetadata(value: CompiledCacheMetadata | undefined): value is CompiledCacheMetadata {
  return (
    value?.version === COMPILED_CACHE_VERSION &&
    typeof value.ownerId === "string" &&
    typeof value.vaultPath === "string" &&
    typeof value.vaultGeneration === "string" &&
    typeof value.publicationId === "string" &&
    typeof value.generation === "string" &&
    value.encoding === "gzip-json"
  );
}

export function activateMemoryWikiCompiledCacheOwner(
  config: ResolvedMemoryWikiConfig,
  vaultGeneration: string,
  compiledCachePublicationId?: string | null,
): void {
  const normalizedVaultGeneration = vaultGeneration.trim();
  if (!normalizedVaultGeneration) {
    throw new Error("Memory Wiki vault generation must not be empty.");
  }
  activeVaults.set(resolveMemoryWikiCompiledCacheOwnerId(config), {
    path: path.resolve(config.vault.path),
    vaultGeneration: normalizedVaultGeneration,
    compiledCachePublicationId: compiledCachePublicationId?.trim() || undefined,
    searchPublicationId: compiledCachePublicationId?.trim() || undefined,
    reconciled: false,
  });
}

export function deactivateMemoryWikiCompiledCacheOwnersExcept(ownerIds: ReadonlySet<string>): void {
  for (const ownerId of activeVaults.keys()) {
    if (!ownerIds.has(ownerId)) {
      activeVaults.delete(ownerId);
    }
  }
}

function resolveActiveVault(config: ResolvedMemoryWikiConfig): ActiveVault | null {
  const active = activeVaults.get(resolveMemoryWikiCompiledCacheOwnerId(config));
  if (!active || active.path !== path.resolve(config.vault.path)) {
    return null;
  }
  return active;
}

function parseSnapshot(
  bytes: Uint8Array,
  generation: string,
): MemoryWikiCompiledCacheSnapshot | null {
  try {
    const serialized = gunzipSync(bytes).toString("utf8");
    if (createHash("sha256").update(serialized).digest("hex") !== generation) {
      return null;
    }
    const parsed = JSON.parse(serialized) as MemoryWikiCompiledCacheSnapshot;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !parsed.digest ||
      typeof parsed.digest !== "object" ||
      !Array.isArray(parsed.digest.pages) ||
      !Array.isArray(parsed.claims)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function resolveMemoryWikiCompiledCacheGeneration(
  snapshot: MemoryWikiCompiledCacheSnapshot,
): string {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

export function createMemoryWikiCompiledCachePublicationId(): string {
  return randomUUID();
}

export function createMemoryWikiCompiledCacheStore(
  openBlobStore: <TMetadata>(options: {
    namespace: string;
    maxEntries: number;
    maxBytesPerEntry: number;
    maxBytesPerNamespace: number;
    overflowPolicy: "reject-new";
  }) => PluginBlobStore<TMetadata>,
  options: { onReadError?: (error: unknown) => void } = {},
): MemoryWikiCompiledCacheStore {
  const store = openBlobStore<CompiledCacheMetadata>({
    namespace: COMPILED_CACHE_NAMESPACE,
    maxEntries: COMPILED_CACHE_MAX_ENTRIES,
    maxBytesPerEntry: COMPILED_CACHE_MAX_BYTES_PER_ENTRY,
    maxBytesPerNamespace: COMPILED_CACHE_MAX_BYTES,
    // A candidate must never evict the last accepted index before validation.
    overflowPolicy: "reject-new",
  });
  async function deleteKey(key: string): Promise<void> {
    await store.delete(key);
  }

  function failureKey(config: ResolvedMemoryWikiConfig) {
    return `compile-failure:${resolveMemoryWikiCompiledCacheOwnerId(config)}`;
  }

  async function readPublication(
    config: ResolvedMemoryWikiConfig,
    vaultGeneration: string,
    publicationId: string,
  ) {
    const ownerId = resolveMemoryWikiCompiledCacheOwnerId(config);
    const entry = await store.lookup(publicationKey(ownerId, publicationId));
    const metadata = entry?.metadata;
    if (
      !entry ||
      !isMetadata(metadata) ||
      metadata.ownerId !== ownerId ||
      metadata.vaultPath !== path.resolve(config.vault.path) ||
      metadata.vaultGeneration !== vaultGeneration ||
      metadata.publicationId !== publicationId
    ) {
      return null;
    }
    return parseSnapshot(entry.bytes, metadata.generation);
  }

  return {
    async readSearch(config) {
      const active = resolveActiveVault(config);
      if (!active?.reconciled || !active.searchPublicationId) {
        return null;
      }
      // Lifecycle activation owns durable identity reads. Explicit search retains
      // the accepted publication when edited sources invalidate prompt preparation.
      const snapshot = await readPublication(
        config,
        active.vaultGeneration,
        active.searchPublicationId,
      );
      return resolveActiveVault(config) === active ? snapshot : null;
    },
    async readFailure(config) {
      const entry = await store.lookup(failureKey(config));
      if (!entry || entry.metadata?.vaultPath !== path.resolve(config.vault.path)) {
        return null;
      }
      const active = resolveActiveVault(config);
      if (!active || entry.metadata.vaultGeneration !== active.vaultGeneration) {
        return null;
      }
      return JSON.parse(gunzipSync(entry.bytes).toString("utf8")) as MemoryWikiCompileFailure;
    },
    async recordFailure(config, failure) {
      const key = failureKey(config);
      if (!failure) {
        await store.delete(key);
        return;
      }
      const active = resolveActiveVault(config);
      const serialized = JSON.stringify(failure);
      await store.register(key, gzipSync(serialized), {
        version: COMPILED_CACHE_VERSION,
        ownerId: resolveMemoryWikiCompiledCacheOwnerId(config),
        vaultPath: path.resolve(config.vault.path),
        vaultGeneration: active?.vaultGeneration ?? "uninitialized",
        publicationId: "compile-failure",
        generation: createHash("sha256").update(serialized).digest("hex"),
        encoding: "gzip-json",
      });
    },
    async read(config) {
      const ownerId = resolveMemoryWikiCompiledCacheOwnerId(config);
      const activeVault = resolveActiveVault(config);
      if (!activeVault?.reconciled || !activeVault.compiledCachePublicationId) {
        return null;
      }
      const key = publicationKey(ownerId, activeVault.compiledCachePublicationId);
      const entry = await store.lookup(key).catch((error: unknown) => {
        options.onReadError?.(error);
        return undefined;
      });
      if (!entry) {
        return null;
      }
      const metadata = entry.metadata;
      const vaultPath = path.resolve(config.vault.path);
      if (!isMetadata(metadata) || metadata.ownerId !== ownerId) {
        return null;
      }
      // Compile or lifecycle refresh owns source changes; prompt preparation never polls files.
      // Every run still binds SQLite to that owner snapshot before exposing immutable lines.
      if (
        metadata.vaultPath !== vaultPath ||
        metadata.vaultGeneration !== activeVault.vaultGeneration
      ) {
        return null;
      }
      if (metadata.publicationId !== activeVault.compiledCachePublicationId) {
        return null;
      }
      const snapshot = parseSnapshot(entry.bytes, metadata.generation);
      if (!snapshot) {
        return null;
      }
      if (resolveActiveVault(config) !== activeVault) {
        return null;
      }
      return snapshot;
    },

    async write(config, snapshot, generation, publicationId) {
      const ownerId = resolveMemoryWikiCompiledCacheOwnerId(config);
      const vaultPath = path.resolve(config.vault.path);
      const activeVault = resolveActiveVault(config);
      if (!activeVault) {
        throw new Error(`Memory Wiki vault is not active: ${vaultPath}`);
      }
      const serialized = JSON.stringify(snapshot);
      if (createHash("sha256").update(serialized).digest("hex") !== generation) {
        throw new Error("Memory Wiki compiled cache generation does not match its snapshot.");
      }
      const metadata: CompiledCacheMetadata = {
        version: COMPILED_CACHE_VERSION,
        ownerId,
        vaultPath,
        vaultGeneration: activeVault.vaultGeneration,
        publicationId,
        generation,
        encoding: "gzip-json",
      };
      await store.register(publicationKey(ownerId, publicationId), gzipSync(serialized), metadata);
      return activeVault;
    },

    async reconcile(config, loadDurableIdentity) {
      const ownerId = resolveMemoryWikiCompiledCacheOwnerId(config);
      const activeVault = resolveActiveVault(config);
      if (!activeVault) {
        return;
      }
      const durableIdentity = await loadDurableIdentity();
      if (durableIdentity.compiledCachePublicationId) {
        try {
          await store.lookup(publicationKey(ownerId, durableIdentity.compiledCachePublicationId));
        } catch (error) {
          options.onReadError?.(error);
          throw error;
        }
      }
      const confirmedIdentity = await loadDurableIdentity();
      if (resolveActiveVault(config) !== activeVault) {
        return;
      }
      if (
        !confirmedIdentity.vaultGeneration ||
        confirmedIdentity.vaultGeneration !== durableIdentity.vaultGeneration ||
        confirmedIdentity.compiledCachePublicationId !== durableIdentity.compiledCachePublicationId
      ) {
        activeVaults.delete(ownerId);
        return;
      }
      // SQLite is observed before the durable identity reread. A cross-process write that
      // races this boundary stays unreadable until the next lifecycle refresh.
      activeVaults.set(ownerId, {
        path: activeVault.path,
        vaultGeneration: confirmedIdentity.vaultGeneration,
        compiledCachePublicationId: confirmedIdentity.compiledCachePublicationId ?? undefined,
        searchPublicationId:
          confirmedIdentity.compiledCachePublicationId ?? activeVault.searchPublicationId,
        reconciled: true,
      });
    },

    async delete(config) {
      const ownerId = resolveMemoryWikiCompiledCacheOwnerId(config);
      for (const entry of await store.entries()) {
        if (isMetadata(entry.metadata) && entry.metadata.ownerId === ownerId) {
          await deleteKey(entry.key);
        }
      }
    },

    async deletePublication(config, publicationId) {
      await deleteKey(publicationKey(resolveMemoryWikiCompiledCacheOwnerId(config), publicationId));
    },

    async deleteOwnersExcept(ownerIds) {
      let deleted = 0;
      for (const entry of await store.entries()) {
        const metadata = entry.metadata;
        if (isMetadata(metadata) && ownerIds.has(metadata.ownerId)) {
          continue;
        }
        await deleteKey(entry.key);
        deleted += 1;
      }
      return deleted;
    },
  };
}

export function configureMemoryWikiCompiledCacheStore(
  store: MemoryWikiCompiledCacheStore | undefined,
): void {
  configuredStore = store;
  if (!store) {
    activeVaults.clear();
  }
}

function requireConfiguredStore(): MemoryWikiCompiledCacheStore {
  if (!configuredStore) {
    throw new Error("Memory Wiki compiled cache store is not configured.");
  }
  return configuredStore;
}

export async function loadMemoryWikiCompiledCache(
  config: ResolvedMemoryWikiConfig,
): Promise<MemoryWikiCompiledCacheSnapshot | null> {
  return await requireConfiguredStore().read(config);
}

export async function loadMemoryWikiSearchSnapshot(config: ResolvedMemoryWikiConfig) {
  return await requireConfiguredStore().readSearch(config);
}

export async function readMemoryWikiCompileFailure(config: ResolvedMemoryWikiConfig) {
  // Status/doctor can inspect configuration before the full plugin runtime starts.
  return configuredStore ? await configuredStore.readFailure(config) : null;
}

export async function recordMemoryWikiCompileFailure(
  config: ResolvedMemoryWikiConfig,
  error: unknown,
) {
  const store = requireConfiguredStore();
  if (error === null) {
    await store.recordFailure(config, null);
    return;
  }
  const previous = await store.readFailure(config);
  const attempts = (previous?.attempts ?? 0) + 1;
  const failedAt = Date.now();
  await store.recordFailure(config, {
    error: formatErrorMessage(error).slice(0, 2_000),
    failedAt,
    nextRetryAt: failedAt + Math.min(15 * 60_000, 30_000 * 2 ** Math.min(attempts - 1, 5)),
    attempts,
  });
}

/** Source edits invalidate prompt preparation, while search keeps its accepted revision. */
export function invalidateMemoryWikiCompiledPrompt(config: ResolvedMemoryWikiConfig): void {
  const active = resolveActiveVault(config);
  if (active) {
    activeVaults.set(resolveMemoryWikiCompiledCacheOwnerId(config), {
      ...active,
      compiledCachePublicationId: undefined,
    });
  }
}

export async function invalidateMemoryWikiCompiledCache(
  config: ResolvedMemoryWikiConfig,
): Promise<void> {
  await requireConfiguredStore().delete(config);
}

export async function reconcileMemoryWikiCompiledCacheOwner(
  config: ResolvedMemoryWikiConfig,
  loadDurableIdentity: () => Promise<{
    vaultGeneration: string | null;
    compiledCachePublicationId: string | null;
  }>,
): Promise<void> {
  await requireConfiguredStore().reconcile(config, loadDurableIdentity);
}

export async function writeMemoryWikiCompiledCache(
  config: ResolvedMemoryWikiConfig,
  snapshot: MemoryWikiCompiledCacheSnapshot,
  generation: string,
  publicationId: string,
  parentPublicationId: string | null,
  validatePublication: () => Promise<void>,
  commitPublication: () => Promise<void>,
  loadDurableIdentity: () => Promise<{
    vaultGeneration: string | null;
    compiledCachePublicationId: string | null;
  }>,
): Promise<void> {
  const store = requireConfiguredStore();
  const activeVault = await store.write(config, snapshot, generation, publicationId);
  try {
    await validatePublication();
  } catch (error) {
    await store.deletePublication(config, publicationId);
    throw error;
  }
  try {
    await commitPublication();
  } catch (error) {
    const identity = await loadDurableIdentity().catch(() => undefined);
    if (identity?.compiledCachePublicationId !== publicationId) {
      await store.deletePublication(config, publicationId);
    }
    throw error;
  }
  // The publication committed. If validation fails, retain its immutable row
  // so a later lifecycle refresh can reconcile it.
  const durableIdentity = await loadDurableIdentity();
  if (
    durableIdentity.vaultGeneration !== activeVault.vaultGeneration ||
    durableIdentity.compiledCachePublicationId !== publicationId
  ) {
    await store.deletePublication(config, publicationId);
    if (resolveActiveVault(config) === activeVault) {
      activeVaults.delete(resolveMemoryWikiCompiledCacheOwnerId(config));
    }
    throw new Error("Memory Wiki vault changed while its compiled cache was being published.");
  }
  if (parentPublicationId) {
    await store.deletePublication(config, parentPublicationId);
  }
  // The publication is durable. A concurrent lifecycle refresh owns in-memory
  // activation; retaining this row lets its next refresh reconcile safely.
  if (resolveActiveVault(config) !== activeVault) {
    return;
  }
  activeVaults.set(resolveMemoryWikiCompiledCacheOwnerId(config), {
    ...activeVault,
    compiledCachePublicationId: publicationId,
    searchPublicationId: publicationId,
    reconciled: true,
  });
}
