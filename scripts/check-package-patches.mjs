#!/usr/bin/env node

// Guards pnpm package patches against unapproved additions.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import {
  getReviewedSecurityPatchRegistrations,
  verifyReviewedSecurityPatches,
} from "./pre-commit/pnpm-audit-prod.mjs";

const LEGACY_PATCHED_DEPENDENCIES = new Map([
  ["baileys@7.0.0-rc12", "patches/baileys@7.0.0-rc12.patch"],
  ["baileys@7.0.0-rc13", "patches/baileys@7.0.0-rc13.patch"],
]);
const reviewedSecurityPatches = getReviewedSecurityPatchRegistrations();
const ALLOWED_PATCHED_DEPENDENCIES = new Map([
  ...LEGACY_PATCHED_DEPENDENCIES,
  ...reviewedSecurityPatches.map(({ specifier, patchPath }) => [specifier, patchPath]),
]);
const REVIEWED_LOCK_PATCHES = new Map(
  reviewedSecurityPatches.map(({ specifier, installHash }) => [specifier, installHash]),
);

const ALLOWED_PATCH_FILES = new Set([
  "patches/.gitkeep",
  ...ALLOWED_PATCHED_DEPENDENCIES.values(),
  // Approved checksum-pinned SkillHub Docker source patches (see PROVENANCE.md).
  // These paths do not authorize any pnpm patchedDependencies declaration.
  "docker/platformclaw-runtime/skillhub-edit/upstream.patch",
  "docker/platformclaw-runtime/skillhub-edit/upstream-tests.patch",
]);

function listTrackedFiles(cwd, patterns) {
  return execFileSync("git", ["ls-files", "-z", "--", ...patterns], {
    cwd,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean)
    .toSorted((left, right) => left.localeCompare(right));
}

function readYamlFile(cwd, relativePath) {
  const filePath = path.join(cwd, relativePath);
  if (!fs.existsSync(filePath)) {
    return {};
  }
  return YAML.parse(fs.readFileSync(filePath, "utf8")) ?? {};
}

function readJsonFile(cwd, relativePath) {
  const filePath = path.join(cwd, relativePath);
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function collectPatchedDependencyViolations(file, patchedDependencies, violations, options = {}) {
  for (const [specifier, patchPathOrHash] of Object.entries(patchedDependencies ?? {})) {
    if (
      options.allowAnyValueForLegacy === true
        ? LEGACY_PATCHED_DEPENDENCIES.has(specifier) ||
          REVIEWED_LOCK_PATCHES.get(specifier) === patchPathOrHash
        : ALLOWED_PATCHED_DEPENDENCIES.get(specifier) === patchPathOrHash
    ) {
      continue;
    }
    violations.push({
      file,
      kind: "patchedDependency",
      detail: `${specifier} -> ${String(patchPathOrHash)}`,
    });
  }
}

function collectWorkspacePatchViolations(cwd, violations) {
  const workspace = readYamlFile(cwd, "pnpm-workspace.yaml");
  collectPatchedDependencyViolations(
    "pnpm-workspace.yaml",
    workspace?.patchedDependencies,
    violations,
  );
}

function collectLockfilePatchViolations(cwd, violations) {
  const lockfile = readYamlFile(cwd, "pnpm-lock.yaml");
  collectPatchedDependencyViolations("pnpm-lock.yaml", lockfile?.patchedDependencies, violations, {
    allowAnyValueForLegacy: true,
  });
}

function collectPackageJsonPatchViolations(cwd, violations) {
  for (const relativePath of listTrackedFiles(cwd, ["*package.json"])) {
    const packageJson = readJsonFile(cwd, relativePath);
    const patchedDependencies = packageJson?.pnpm?.patchedDependencies;
    for (const [specifier, patchPath] of Object.entries(patchedDependencies ?? {})) {
      violations.push({
        file: relativePath,
        kind: "packageJsonPatchedDependency",
        detail: `${specifier} -> ${String(patchPath)}`,
      });
    }
  }
}

function collectPatchFileViolations(cwd, violations) {
  for (const relativePath of listTrackedFiles(cwd, ["*.patch"])) {
    if (!fs.existsSync(path.join(cwd, relativePath))) {
      continue;
    }
    if (ALLOWED_PATCH_FILES.has(relativePath)) {
      continue;
    }
    violations.push({
      file: relativePath,
      kind: "patchFile",
      detail: "new package patch file",
    });
  }
}

/**
 * Collects disallowed package patch declarations and patch files.
 */
export function collectPackagePatchViolations(cwd = process.cwd()) {
  const violations = [];
  collectWorkspacePatchViolations(cwd, violations);
  collectLockfilePatchViolations(cwd, violations);
  collectPackageJsonPatchViolations(cwd, violations);
  collectPatchFileViolations(cwd, violations);
  return violations;
}

/**
 * Runs the package patch guard.
 */
export async function main() {
  const violations = collectPackagePatchViolations();
  if (violations.length === 0) {
    const presentPatchFiles = new Set(
      listTrackedFiles(process.cwd(), ["*.patch"]).filter((relativePath) =>
        fs.existsSync(path.join(process.cwd(), relativePath)),
      ),
    );
    const declaredPatches = new Set([
      ...Object.keys(readYamlFile(process.cwd(), "pnpm-workspace.yaml").patchedDependencies ?? {}),
      ...Object.keys(readYamlFile(process.cwd(), "pnpm-lock.yaml").patchedDependencies ?? {}),
    ]);
    await verifyReviewedSecurityPatches({
      rootDir: process.cwd(),
      lockfileText: fs.readFileSync(path.join(process.cwd(), "pnpm-lock.yaml"), "utf8"),
      requiredPatchSpecifiers: reviewedSecurityPatches
        .filter(
          ({ specifier, patchPath }) =>
            presentPatchFiles.has(patchPath) || declaredPatches.has(specifier),
        )
        .map(({ specifier }) => specifier),
    });
    process.stdout.write(
      `PASS package patch guard: only approved pnpm patches; ${ALLOWED_PATCHED_DEPENDENCIES.size} registrations allowed with security artifact verification.\n`,
    );
    return;
  }

  console.error(
    "FAIL package patch guard: new pnpm package patches are not allowed. Upstream the fix, publish a new package version, then bump the dependency instead.",
  );
  for (const violation of violations) {
    console.error(`- ${violation.file}: ${violation.kind}: ${violation.detail}`);
  }
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(
    /** @param {unknown} error */ (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}
