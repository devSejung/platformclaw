#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import process from "node:process";

const repoRoot = resolve(import.meta.dirname, "..");
const defaults = {
  apply: false,
  buildLockOwner: undefined,
  cacheMax: "20gb",
  cacheMinFree: "20gb",
  cacheReserved: "5gb",
  failedBuildSha: undefined,
  intermediateSha: undefined,
  keepReleaseArchives: 3,
  keepRollbackImages: 1,
  outputDir: resolve(repoRoot, ".artifacts", "platformclaw"),
  skipArchives: false,
  skipCache: false,
  skipFinalImages: false,
};

function fail(message) {
  throw new Error(message);
}

function integer(value, name) {
  if (!/^\d+$/u.test(value)) fail(`${name} requires a non-negative integer`);
  return Number(value);
}

function readArgs(argv) {
  const options = { ...defaults };
  const value = (index, name) => argv[index + 1] ?? fail(`${name} requires a value`);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") options.apply = true;
    else if (arg === "--build-lock-owner") {
      options.buildLockOwner = integer(value(index, arg), arg);
      index += 1;
    } else if (arg === "--failed-build-sha") {
      options.failedBuildSha = value(index, arg);
      index += 1;
    } else if (arg === "--intermediate-sha") {
      options.intermediateSha = value(index, arg);
      index += 1;
    } else if (arg === "--keep-rollback-images") {
      options.keepRollbackImages = integer(value(index, arg), arg);
      index += 1;
    } else if (arg === "--keep-release-archives") {
      options.keepReleaseArchives = integer(value(index, arg), arg);
      index += 1;
    } else if (arg === "--output-dir") {
      options.outputDir = resolve(value(index, arg));
      index += 1;
    } else if (arg === "--cache-max") {
      options.cacheMax = value(index, arg);
      index += 1;
    } else if (arg === "--cache-reserved") {
      options.cacheReserved = value(index, arg);
      index += 1;
    } else if (arg === "--cache-min-free") {
      options.cacheMinFree = value(index, arg);
      index += 1;
    } else if (arg === "--skip-archives") options.skipArchives = true;
    else if (arg === "--skip-cache") options.skipCache = true;
    else if (arg === "--skip-final-images") options.skipFinalImages = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: node scripts/platformclaw-dev-cleanup.mjs [options]

Home-development Docker cleanup. Preview is the default; pass --apply to mutate.

  --apply                       Perform cleanup
  --intermediate-sha <sha>      Remove intermediate images for one build SHA
  --failed-build-sha <sha>      Remove unvalidated final images for one build SHA
  --keep-rollback-images <n>    Keep current image plus n rollback images (default 1)
  --keep-release-archives <n>   Keep n newest release tar files (default 3)
  --output-dir <path>           Release archive directory
  --cache-max <size>            BuildKit maximum used space (default 20gb)
  --cache-reserved <size>       BuildKit reserved space (default 5gb)
  --cache-min-free <size>       Host minimum free space target (default 20gb)
  --skip-final-images           Do not prune final/rollback images
  --skip-archives               Do not prune release archives
  --skip-cache                  Do not prune the shared BuildKit cache`);
      process.exit(0);
    } else fail(`Unknown argument: ${arg}`);
  }
  for (const [name, sha] of [
    ["--intermediate-sha", options.intermediateSha],
    ["--failed-build-sha", options.failedBuildSha],
  ]) {
    if (sha && !/^[0-9a-f]{7,64}$/u.test(sha)) fail(`${name} must be a hexadecimal Git SHA`);
  }
  for (const size of [options.cacheMax, options.cacheReserved, options.cacheMinFree]) {
    if (!/^\d+(?:\.\d+)?(?:[kmgt]b?)$/iu.test(size)) fail(`Invalid cache size: ${size}`);
  }
  return options;
}

function docker(args, { allowFailure = false } = {}) {
  const result = spawnSync("docker", args, { cwd: repoRoot, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    fail(result.stderr.trim() || `docker ${args.join(" ")} failed (${result.status})`);
  }
  return result;
}

function announce(options, label, action) {
  console.log(`${options.apply ? "APPLY" : "PREVIEW"}: ${label}`);
  if (options.apply) action();
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return true;
  }
}

function dockerResourceLockPort() {
  const engineId = docker(["info", "--format", "{{.ID}}"]).stdout.trim();
  const key = createHash("sha256").update(engineId).digest().readUInt16BE(0);
  return 49_152 + (key % 16_384);
}

async function acquireCleanupLock(options) {
  if (options.buildLockOwner !== undefined) {
    if (!processIsAlive(options.buildLockOwner)) fail("Build-owned cleanup owner is not alive");
    return { owned: false, server: undefined };
  }
  const server = createServer();
  try {
    await new Promise((resolveLock, reject) => {
      server.once("error", reject);
      server.listen(
        { host: "127.0.0.1", port: dockerResourceLockPort(), exclusive: true },
        resolveLock,
      );
    });
    return { owned: true, server };
  } catch (error) {
    if (error?.code === "EADDRINUSE") return undefined;
    throw error;
  }
}

function safeMtime(path) {
  try {
    return statSync(path).mtimeMs;
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function imageRows(repository) {
  return docker(["image", "ls", repository, "--no-trunc", "--format", "{{json .}}"])
    .stdout.split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((row) => row.Tag && row.Tag !== "<none>");
}

function removeIntermediateImages(options, used) {
  for (const repository of [
    "platformclaw-jammy-build",
    "platformclaw-openclaw-build",
    "platformclaw-runtime-assets",
    "platformclaw-control-assets",
  ]) {
    const rows = imageRows(repository).filter(
      (row) => !options.intermediateSha || row.Tag === options.intermediateSha,
    );
    for (const row of rows) {
      if (used.has(row.ID)) {
        console.log(`KEEP: container uses intermediate image ${row.Repository}:${row.Tag}`);
        continue;
      }
      const tag = `${row.Repository}:${row.Tag}`;
      announce(options, `remove intermediate image ${tag}`, () => {
        docker(["image", "rm", tag]);
      });
    }
  }
}

function removeFailedFinalImages(options, used) {
  if (!options.failedBuildSha) return;
  for (const repository of ["platformclaw", "platformclaw-sandbox"]) {
    for (const row of imageRows(repository).filter(
      (entry) => entry.Tag === options.failedBuildSha,
    )) {
      if (used.has(row.ID)) {
        console.log(`KEEP: container uses failed-build image ${row.Repository}:${row.Tag}`);
        continue;
      }
      const tag = `${row.Repository}:${row.Tag}`;
      announce(options, `remove unvalidated final image ${tag}`, () => {
        docker(["image", "rm", tag]);
      });
    }
  }
}

function usedImageIds() {
  const ids = docker(["ps", "-aq"]).stdout.trim().split(/\s+/u).filter(Boolean);
  const used = new Set();
  for (const id of ids) {
    const result = docker(["inspect", "--format", "{{.Image}}", id], { allowFailure: true });
    if (result.status !== 0) {
      if (/No such object/u.test(result.stderr)) continue;
      fail(result.stderr.trim() || `Unable to inspect container ${id}`);
    }
    if (result.stdout.trim()) used.add(result.stdout.trim());
  }
  return used;
}

function pruneRepository(options, repository, used) {
  const rows = imageRows(repository).sort(
    (a, b) => Date.parse(b.CreatedAt) - Date.parse(a.CreatedAt),
  );
  const ids = [...new Set(rows.map((row) => row.ID))];
  const currentId = rows.find((row) => !/^[0-9a-f]{7,64}$/u.test(row.Tag))?.ID ?? ids[0];
  const orderedIds = [currentId, ...ids.filter((id) => id !== currentId)].filter(Boolean);
  const keep = new Set(orderedIds.slice(0, options.keepRollbackImages + 1));
  for (const row of rows) {
    if (keep.has(row.ID) || used.has(row.ID)) continue;
    const tag = `${row.Repository}:${row.Tag}`;
    announce(options, `remove old rollback tag ${tag}`, () => {
      docker(["image", "rm", tag]);
    });
  }
}

function pruneArchives(options) {
  if (!existsSync(options.outputDir)) return;
  const root = resolve(options.outputDir);
  let names;
  try {
    names = readdirSync(root);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const name of names.filter((entry) => /^platformclaw-.+\.tar\.lock$/u.test(entry))) {
    const path = resolve(root, name);
    const archive = path.slice(0, -".lock".length);
    announce(options, `roll back abandoned release publication ${archive}`, () => {
      rmSync(archive, { force: true });
      rmSync(`${archive}.sha256`, { force: true });
      rmSync(path, { force: true });
    });
  }
  for (const name of names.filter((entry) =>
    /^platformclaw-.+\.tar\.lock\.candidate-\d+-[0-9a-f-]+$/u.test(entry),
  )) {
    const path = resolve(root, name);
    announce(options, `remove abandoned release lock candidate ${path}`, () =>
      rmSync(path, { force: true }),
    );
  }
  for (const name of names.filter((entry) =>
    /^platformclaw-.+\.tar(?:\.sha256)?\.tmp-\d+$/u.test(entry),
  )) {
    const path = resolve(root, name);
    announce(options, `remove abandoned release temporary ${path}`, () =>
      rmSync(path, { force: true }),
    );
  }
  if (options.skipArchives) return;
  const archives = names
    .filter((name) => /^platformclaw-.+\.tar$/u.test(name))
    .map((name) => ({ name, path: resolve(root, name) }))
    .filter((entry) => entry.path.startsWith(`${root}\\`) || entry.path.startsWith(`${root}/`))
    .map((entry) => ({ ...entry, mtimeMs: safeMtime(entry.path) }))
    .filter((entry) => entry.mtimeMs !== undefined)
    .filter((entry) => {
      if (existsSync(`${entry.path}.lock`)) {
        console.log(`KEEP: release publication is active for ${entry.path}`);
        return false;
      }
      if (existsSync(`${entry.path}.sha256`)) return true;
      announce(options, `remove incomplete release artifact ${entry.path}`, () =>
        rmSync(entry.path, { force: true }),
      );
      return false;
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const name of names.filter((entry) => /^platformclaw-.+\.tar\.sha256$/u.test(entry))) {
    const checksum = resolve(root, name);
    const archive = checksum.slice(0, -".sha256".length);
    if (existsSync(`${archive}.lock`)) continue;
    if (!existsSync(archive)) {
      announce(options, `remove orphan release checksum ${checksum}`, () =>
        rmSync(checksum, { force: true }),
      );
    }
  }
  for (const archive of archives.slice(options.keepReleaseArchives)) {
    for (const path of [archive.path, `${archive.path}.sha256`]) {
      if (!existsSync(path)) continue;
      announce(options, `remove old release artifact ${path}`, () => rmSync(path, { force: true }));
    }
  }
}

function pruneBuildCache(options) {
  if (options.skipCache) return;
  announce(
    options,
    `prune BuildKit cache (max=${options.cacheMax}, reserved=${options.cacheReserved}, min-free=${options.cacheMinFree})`,
    () => {
      docker([
        "buildx",
        "prune",
        "--all",
        "--force",
        "--max-used-space",
        options.cacheMax,
        "--reserved-space",
        options.cacheReserved,
        "--min-free-space",
        options.cacheMinFree,
      ]);
    },
  );
}

const options = readArgs(process.argv.slice(2));
const cleanupLock = await acquireCleanupLock(options);
if (!cleanupLock) {
  console.log("SKIP: a PlatformClaw build is active");
  process.exit(0);
}
try {
  docker(["version"]);
  const used = usedImageIds();
  removeIntermediateImages(options, used);
  removeFailedFinalImages(options, used);
  if (!options.skipFinalImages) {
    pruneRepository(options, "platformclaw", used);
    pruneRepository(options, "platformclaw-sandbox", used);
  }
  pruneArchives(options);
  pruneBuildCache(options);
  console.log(
    options.apply ? "PlatformClaw development cleanup complete" : "Preview only; pass --apply",
  );
} finally {
  if (cleanupLock.owned) {
    await new Promise((resolveClose, reject) => {
      cleanupLock.server.close((error) => (error ? reject(error) : resolveClose()));
    });
  }
}
