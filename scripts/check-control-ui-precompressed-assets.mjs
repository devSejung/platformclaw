#!/usr/bin/env node
// Verifies each generated Control UI sidecar encodes the final emitted asset bytes.
import fs from "node:fs";
import path from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
const repoRoot = resolveRepoRoot(import.meta.url);
const assetsDir = path.join(repoRoot, "dist", "control-ui", "assets");
const errors = [];
let checked = 0;

for (const entry of fs.readdirSync(assetsDir, { withFileTypes: true, recursive: true })) {
  if (!entry.isFile()) {
    continue;
  }
  const suffix = entry.name.endsWith(".br") ? ".br" : entry.name.endsWith(".gz") ? ".gz" : null;
  if (!suffix) {
    continue;
  }
  const sidecarPath = path.join(entry.parentPath, entry.name);
  const relativePath = path.relative(assetsDir, sidecarPath);
  const sourcePath = sidecarPath.slice(0, -suffix.length);
  try {
    const encoded = fs.readFileSync(sidecarPath);
    const decoded = suffix === ".br" ? brotliDecompressSync(encoded) : gunzipSync(encoded);
    const source = fs.readFileSync(sourcePath);
    if (!decoded.equals(source)) {
      errors.push(`${relativePath}: decoded bytes differ from ${path.basename(sourcePath)}`);
    }
  } catch (error) {
    errors.push(`${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  checked += 1;
}

if (checked === 0) {
  errors.push("no precompressed Control UI assets found");
}
if (errors.length > 0) {
  throw new Error(`Control UI precompressed asset verification failed:\n${errors.join("\n")}`);
}

process.stdout.write(`verified ${checked} finalized Control UI sidecars\n`);
