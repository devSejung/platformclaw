// Check Package Patches tests cover check package patches script behavior.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectPackagePatchViolations } from "../../scripts/check-package-patches.mjs";
import {
  getReviewedSecurityPatchRegistrations,
  verifyReviewedSecurityPatches,
} from "../../scripts/pre-commit/pnpm-audit-prod.mjs";
import { cleanupTempDirs, makeTempRepoRoot, writeJsonFile } from "../helpers/temp-repo.js";

const tempDirs: string[] = [];
const repoRoot = path.resolve(import.meta.dirname, "../..");
const productPatchPath = "patches/pdfjs-dist@6.4.299.patch";
const pdfjsIntegrity =
  "sha512-AVl138zALtfaAPvADulE0PZThbYzCBS79nL4pOSL/6Sm/4AH5A21BD9VHt97OlCuzJuCpmeZtAtkinisF4Vb1g==";

const nestedGitEnvKeys = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_QUARANTINE_PATH",
  "GIT_WORK_TREE",
] as const;

function createNestedGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const key of nestedGitEnvKeys) {
    delete env[key];
  }
  return env;
}

function git(cwd: string, args: string[]) {
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: createNestedGitEnv(),
  });
}

function makeRepo() {
  const dir = makeTempRepoRoot(tempDirs, "openclaw-package-patches-");
  git(dir, ["init", "-q", "--initial-branch=main"]);
  writeJsonFile(path.join(dir, "package.json"), { name: "fixture" });
  writeFileSync(path.join(dir, "pnpm-workspace.yaml"), "packages:\n  - .\n", "utf8");
  writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
  git(dir, ["add", "package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml"]);
  return dir;
}

function makeSecurityRepo() {
  const dir = makeRepo();
  for (const name of ["pnpm-workspace.yaml", "pnpm-lock.yaml"]) {
    copyFileSync(path.join(repoRoot, name), path.join(dir, name));
  }
  const patchPaths = [
    ...getReviewedSecurityPatchRegistrations().map(({ patchPath }) => patchPath),
    productPatchPath,
  ];
  for (const patchPath of patchPaths) {
    mkdirSync(path.dirname(path.join(dir, patchPath)), { recursive: true });
    copyFileSync(path.join(repoRoot, patchPath), path.join(dir, patchPath));
  }
  git(dir, ["add", "pnpm-workspace.yaml", "pnpm-lock.yaml", "patches"]);
  return dir;
}

function makeProductRepo() {
  const dir = makeRepo();
  const patch = readFileSync(path.join(repoRoot, productPatchPath));
  const hash = createHash("sha256").update(patch).digest("hex");
  mkdirSync(path.join(dir, "patches"), { recursive: true });
  writeFileSync(path.join(dir, productPatchPath), patch);
  writeFileSync(
    path.join(dir, "pnpm-workspace.yaml"),
    `packages:\n  - .\npatchedDependencies:\n  pdfjs-dist@6.4.299: ${productPatchPath}\n`,
  );
  writeFileSync(
    path.join(dir, "pnpm-lock.yaml"),
    `lockfileVersion: '9.0'
patchedDependencies:
  pdfjs-dist@6.4.299: ${hash}
importers:
  ui:
    dependencies:
      pdfjs-dist:
        specifier: 6.4.299
        version: 6.4.299(patch_hash=${hash})
packages:
  pdfjs-dist@6.4.299:
    resolution: {integrity: ${pdfjsIntegrity}}
snapshots:
  pdfjs-dist@6.4.299(patch_hash=${hash}): {}
`,
  );
  git(dir, ["add", "pnpm-workspace.yaml", "pnpm-lock.yaml", "patches"]);
  return { dir, hash };
}

function runPatchGuard(cwd: string) {
  return spawnSync(process.execPath, [path.join(repoRoot, "scripts/check-package-patches.mjs")], {
    cwd,
    encoding: "utf8",
    env: createNestedGitEnv(),
  });
}

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

describe("check-package-patches", () => {
  it("verifies the approved PDF.js product patch without a security advisory registration", () => {
    const { dir } = makeProductRepo();
    const securitySpecifiers = getReviewedSecurityPatchRegistrations().map(
      ({ specifier }) => specifier,
    );
    expect(securitySpecifiers).not.toContain("pdfjs-dist@6.4.299");
    expect(collectPackagePatchViolations(dir)).toEqual([]);
    const result = runPatchGuard(dir);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("product artifact verification");
  });

  it.each([
    "changed product bytes",
    "missing product patch",
    "wrong product version",
    "wrong product path",
    "wrong product lock hash",
    "wrong product archive integrity",
    "unpatched product snapshot",
    "duplicate product patch hash",
    "orphaned product patch",
  ])("rejects %s at the actual CLI boundary", (change) => {
    const { dir, hash } = makeProductRepo();
    const patchFile = path.join(dir, productPatchPath);
    const workspacePath = path.join(dir, "pnpm-workspace.yaml");
    const lockPath = path.join(dir, "pnpm-lock.yaml");
    if (change === "changed product bytes") {
      writeFileSync(patchFile, "unreviewed bytes\n");
    } else if (change === "missing product patch") {
      rmSync(patchFile);
    } else if (change === "wrong product version") {
      for (const file of [workspacePath, lockPath]) {
        writeFileSync(file, readFileSync(file, "utf8").replaceAll("6.4.299", "6.4.300"));
      }
    } else if (change === "wrong product path") {
      writeFileSync(
        workspacePath,
        readFileSync(workspacePath, "utf8").replace(productPatchPath, "patches/other.patch"),
      );
    } else if (change === "wrong product lock hash") {
      writeFileSync(lockPath, readFileSync(lockPath, "utf8").replaceAll(hash, "0"));
    } else if (change === "wrong product archive integrity") {
      writeFileSync(
        lockPath,
        readFileSync(lockPath, "utf8").replace(pdfjsIntegrity, "sha512-unreviewed"),
      );
    } else if (change === "unpatched product snapshot") {
      writeFileSync(
        lockPath,
        readFileSync(lockPath, "utf8").replaceAll(`(patch_hash=${hash})`, ""),
      );
    } else if (change === "duplicate product patch hash") {
      writeFileSync(
        lockPath,
        readFileSync(lockPath, "utf8").replaceAll(
          `(patch_hash=${hash})`,
          `(patch_hash=${hash})(patch_hash=${hash})`,
        ),
      );
    } else if (change === "orphaned product patch") {
      writeFileSync(workspacePath, "packages:\n  - .\n");
      writeFileSync(lockPath, "lockfileVersion: '9.0'\nimporters:\n  .:\npackages:\nsnapshots:\n");
    }
    const result = runPatchGuard(dir);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).not.toEqual("");
    expect(result.stderr).toContain(change === "missing product patch" ? "ENOENT" : "pdfjs-dist@");
  });

  it("admits the approved security artifacts only after actual CLI verification", () => {
    const dir = makeSecurityRepo();
    expect(collectPackagePatchViolations(dir)).toEqual([]);
    const result = runPatchGuard(dir);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("security artifact verification");
  });

  it.each([
    "changed bytes",
    "missing patch",
    "wrong lock hash",
    "unpatched snapshots",
    "orphaned known patch",
    "tampered orphaned known patch",
    "missing declared orphaned patch",
  ])("rejects %s at the actual CLI boundary", async (change) => {
    const dir = makeSecurityRepo();
    const artifact = getReviewedSecurityPatchRegistrations()[0]!;
    if (change === "changed bytes" || change === "tampered orphaned known patch") {
      writeFileSync(path.join(dir, artifact.patchPath), "unreviewed bytes\n");
    } else if (change === "missing patch") {
      rmSync(path.join(dir, artifact.patchPath));
    }
    const lockPath = path.join(dir, "pnpm-lock.yaml");
    if (change === "wrong lock hash") {
      writeFileSync(lockPath, readFileSync(lockPath, "utf8").replaceAll(artifact.installHash, "0"));
    } else if (change === "unpatched snapshots") {
      writeFileSync(
        lockPath,
        readFileSync(lockPath, "utf8").replaceAll(`(patch_hash=${artifact.installHash})`, ""),
      );
    } else if (change.includes("orphaned")) {
      const missingDeclared = change === "missing declared orphaned patch";
      const prefix = missingDeclared
        ? readFileSync(lockPath, "utf8").split("importers:")[0]!
        : "lockfileVersion: '9.0'\n";
      const inactiveLock = `${prefix}importers:\n  .:\npackages:\nsnapshots:\n`;
      writeFileSync(lockPath, inactiveLock);
      if (missingDeclared) {
        for (const { patchPath } of getReviewedSecurityPatchRegistrations()) {
          rmSync(path.join(dir, patchPath));
        }
      } else {
        writeFileSync(path.join(dir, "pnpm-workspace.yaml"), "packages:\n  - .\n");
      }
      expect(collectPackagePatchViolations(dir)).toEqual([]);
      await expect(
        verifyReviewedSecurityPatches({ rootDir: dir, lockfileText: inactiveLock }),
      ).resolves.toBeUndefined();
    }
    const result = runPatchGuard(dir);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).not.toEqual("");
    if (change.includes("orphaned")) {
      expect(result.stderr).toContain(
        `Reviewed audit patch registration or integrity changed: ${artifact.specifier}`,
      );
    }
  });

  it("allows approved pnpm patches", () => {
    const dir = makeRepo();
    mkdirSync(path.join(dir, "patches"), { recursive: true });
    writeFileSync(
      path.join(dir, "pnpm-workspace.yaml"),
      `packages:
  - .
patchedDependencies:
  "baileys@7.0.0-rc12": "patches/baileys@7.0.0-rc12.patch"
`,
      "utf8",
    );
    writeFileSync(
      path.join(dir, "pnpm-lock.yaml"),
      `lockfileVersion: '9.0'
patchedDependencies:
  baileys@7.0.0-rc12: a9aea1790d2c65b1ae543c77faca4119bbfb91ee3b6ca6c38d1cad4f5702ada2
`,
      "utf8",
    );
    writeFileSync(path.join(dir, "patches", "baileys@7.0.0-rc12.patch"), "diff\n", "utf8");
    git(dir, ["add", "pnpm-workspace.yaml", "pnpm-lock.yaml", "patches"]);

    expect(collectPackagePatchViolations(dir)).toEqual([]);
  });

  it("keeps approved registry source patches separate from pnpm patch approval", () => {
    const dir = makeRepo();
    const sourcePath = "docker/platformclaw-runtime/skillhub-edit";
    const sourceDir = path.join(dir, sourcePath);
    mkdirSync(sourceDir, { recursive: true });
    for (const name of ["upstream.patch", "upstream-tests.patch"]) {
      writeFileSync(path.join(sourceDir, name), "diff\n", "utf8");
    }
    git(dir, ["add", sourcePath]);
    expect(collectPackagePatchViolations(dir)).toEqual([]);

    writeFileSync(path.join(sourceDir, "unapproved.patch"), "diff\n", "utf8");
    writeFileSync(
      path.join(dir, "pnpm-workspace.yaml"),
      `packages:
  - .
patchedDependencies:
  "left-pad@1.3.0": "${sourcePath}/upstream.patch"
`,
      "utf8",
    );
    git(dir, ["add", "pnpm-workspace.yaml", sourcePath]);
    expect(collectPackagePatchViolations(dir)).toEqual([
      {
        file: "pnpm-workspace.yaml",
        kind: "patchedDependency",
        detail: `left-pad@1.3.0 -> ${sourcePath}/upstream.patch`,
      },
      {
        file: `${sourcePath}/unapproved.patch`,
        kind: "patchFile",
        detail: "new package patch file",
      },
    ]);
  });

  it("rejects new workspace patchedDependencies and patch files", () => {
    const dir = makeRepo();
    mkdirSync(path.join(dir, "patches"), { recursive: true });
    mkdirSync(path.join(dir, "fixtures"), { recursive: true });
    writeFileSync(
      path.join(dir, "pnpm-workspace.yaml"),
      `packages:
  - .
patchedDependencies:
  "left-pad@1.3.0": "patches/left-pad@1.3.0.patch"
`,
      "utf8",
    );
    writeFileSync(path.join(dir, "patches", "left-pad@1.3.0.patch"), "diff\n", "utf8");
    writeFileSync(path.join(dir, "fixtures", "fixture.patch"), "diff\n", "utf8");
    git(dir, ["add", "pnpm-workspace.yaml", "patches", "fixtures"]);

    expect(collectPackagePatchViolations(dir)).toEqual([
      {
        file: "pnpm-workspace.yaml",
        kind: "patchedDependency",
        detail: "left-pad@1.3.0 -> patches/left-pad@1.3.0.patch",
      },
      {
        file: "fixtures/fixture.patch",
        kind: "patchFile",
        detail: "new package patch file",
      },
      {
        file: "patches/left-pad@1.3.0.patch",
        kind: "patchFile",
        detail: "new package patch file",
      },
    ]);
  });

  it("allows deleted legacy patch files during the commit that removes them", () => {
    const dir = makeRepo();
    mkdirSync(path.join(dir, "patches"), { recursive: true });
    writeFileSync(
      path.join(dir, "patches", "@agentclientprotocol__claude-agent-acp@0.33.1.patch"),
      "diff\n",
      "utf8",
    );
    git(dir, ["add", "patches"]);
    rmSync(path.join(dir, "patches", "@agentclientprotocol__claude-agent-acp@0.33.1.patch"));

    expect(collectPackagePatchViolations(dir)).toEqual([]);
  });

  it("rejects lockfile-only and package-local patch declarations", () => {
    const dir = makeRepo();
    writeJsonFile(path.join(dir, "package.json"), {
      name: "fixture",
      pnpm: {
        patchedDependencies: {
          "nested@1.0.0": "patches/nested.patch",
        },
      },
    });
    writeFileSync(
      path.join(dir, "pnpm-lock.yaml"),
      `lockfileVersion: '9.0'
patchedDependencies:
  hidden@1.0.0: abc123
`,
      "utf8",
    );
    git(dir, ["add", "package.json", "pnpm-lock.yaml"]);

    expect(collectPackagePatchViolations(dir)).toEqual([
      {
        file: "pnpm-lock.yaml",
        kind: "patchedDependency",
        detail: "hidden@1.0.0 -> abc123",
      },
      {
        file: "package.json",
        kind: "packageJsonPatchedDependency",
        detail: "nested@1.0.0 -> patches/nested.patch",
      },
    ]);
  });

  it("skips tracked package manifests deleted in the worktree", () => {
    const dir = makeRepo();
    mkdirSync(path.join(dir, "packages", "deleted"), { recursive: true });
    writeJsonFile(path.join(dir, "packages", "deleted", "package.json"), {
      name: "deleted",
      pnpm: {
        patchedDependencies: {
          "deleted-only@1.0.0": "patches/deleted-only.patch",
        },
      },
    });
    git(dir, ["add", "packages/deleted/package.json"]);
    rmSync(path.join(dir, "packages", "deleted", "package.json"));

    expect(collectPackagePatchViolations(dir)).toEqual([]);
  });
});
