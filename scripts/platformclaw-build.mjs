#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import process from "node:process";

const repoRoot = resolve(import.meta.dirname, "..");
const defaultPipConfigPath = resolve(homedir(), ".config", "platformclaw", "build", "pip.conf");

/**
 * @typedef {object} BuildOptions
 * @property {boolean} allowDirty
 * @property {string | undefined} aptSources
 * @property {boolean} exportImage
 * @property {string} extensions
 * @property {string} outputDir
 * @property {string | undefined} pipConfig
 * @property {string | undefined} version
 */

function run(command, args, options = {}) {
  console.log(`> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    if (options.capture && result.stderr) {
      process.stderr.write(result.stderr);
    }
    throw new Error(`${command} exited with status ${result.status}`);
  }
  return options.capture ? result.stdout.trim() : "";
}

function readArgs(argv) {
  /** @type {BuildOptions} */
  const options = {
    allowDirty: false,
    aptSources: undefined,
    exportImage: true,
    extensions: "",
    outputDir: resolve(repoRoot, ".artifacts", "platformclaw"),
    pipConfig: existsSync(defaultPipConfigPath) ? defaultPipConfigPath : undefined,
    version: undefined,
  };
  const readValue = (index, option) => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${option} requires a value`);
    }
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apt-sources") {
      options.aptSources = resolve(readValue(index, arg));
      index += 1;
    } else if (arg === "--pip-config") {
      options.pipConfig = resolve(readValue(index, arg));
      index += 1;
    } else if (arg === "--extensions") {
      options.extensions = readValue(index, arg);
      index += 1;
    } else if (arg === "--allow-dirty") {
      options.allowDirty = true;
    } else if (arg === "--no-export") {
      options.exportImage = false;
    } else if (arg === "--output-dir") {
      options.outputDir = resolve(readValue(index, arg));
      index += 1;
    } else if (arg === "--version") {
      options.version = readValue(index, arg);
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: node scripts/platformclaw-build.mjs [options]

Options:
  --apt-sources <path>  Private Jammy apt sources file, mounted as a BuildKit secret
  --pip-config <path>   pip.conf for the Jammy sandbox (default: ${defaultPipConfigPath})
  --extensions <ids>    Comma- or space-separated plugins to bundle for offline use
  --version <value>     Image/artifact version (defaults to package.json version)
  --output-dir <path>   Export directory (defaults to .artifacts/platformclaw)
  --no-export           Build and smoke-test without docker save
  --allow-dirty         Permit local validation only; requires --no-export
`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function sha256File(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

function optionalImageId(tag) {
  const result = spawnSync("docker", ["image", "inspect", "--format", "{{.Id}}", tag], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status === 0) {
    return result.stdout.trim();
  }
  if (result.status === 1 && /No such image/u.test(result.stderr)) {
    return undefined;
  }
  throw new Error(result.stderr.trim() || `Unable to inspect image tag ${tag}`);
}

function restoreImageTag(tag, imageId) {
  const args = imageId ? ["image", "tag", imageId, tag] : ["image", "rm", tag];
  const result = spawnSync("docker", args, { cwd: repoRoot, encoding: "utf8" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0 && !/No such image/u.test(result.stderr)) {
    throw new Error(result.stderr.trim() || `Failed to restore image tag ${tag}`);
  }
  if (optionalImageId(tag) !== imageId) {
    throw new Error(`Image tag rollback failed: ${tag}`);
  }
}

function removeDanglingImage(imageId, previousId) {
  if (!imageId || imageId === previousId) {
    return;
  }
  const inspect = spawnSync(
    "docker",
    ["image", "inspect", "--format", "{{json .RepoTags}}", imageId],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
  if (inspect.status === 1 && /No such image/u.test(inspect.stderr)) {
    return;
  }
  if (inspect.error || inspect.status !== 0) {
    console.warn(`Unable to inspect failed-build image ${imageId}`);
    return;
  }
  const tags = JSON.parse(inspect.stdout);
  if (Array.isArray(tags) && tags.length > 0) {
    return;
  }
  const removed = spawnSync("docker", ["image", "rm", imageId], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (removed.error || (removed.status !== 0 && !/No such image/u.test(removed.stderr))) {
    console.warn(`Unable to remove failed-build image ${imageId}`);
  }
}

function publishOwnedLock(path, state) {
  const owner = { pid: process.pid, token: randomUUID(), ...state };
  writeFileSync(path, `${JSON.stringify(owner)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return owner;
}

function removeOwnedLock(path, owner) {
  const actual = JSON.parse(readFileSync(path, "utf8"));
  if (actual.pid !== owner.pid || actual.token !== owner.token) {
    throw new Error(`Release publication lock ownership changed: ${path}`);
  }
  rmSync(path);
}

function rollbackPublicationFiles() {
  if (!publicationReplacementStarted) {
    return;
  }
  if (publicationLockOwner.hadArtifact && existsSync(publicationArtifactBackup)) {
    rmSync(publicationArtifactPath, { force: true });
    renameSync(publicationArtifactBackup, publicationArtifactPath);
  } else if (!publicationLockOwner.hadArtifact) {
    rmSync(publicationArtifactPath, { force: true });
  }
  if (publicationLockOwner.hadChecksum && existsSync(publicationChecksumBackup)) {
    rmSync(publicationChecksumPath, { force: true });
    renameSync(publicationChecksumBackup, publicationChecksumPath);
  } else if (!publicationLockOwner.hadChecksum) {
    rmSync(publicationChecksumPath, { force: true });
  }
  publicationReplacementStarted = false;
}

function discardPublicationBackups() {
  rmSync(publicationArtifactBackup, { force: true });
  rmSync(publicationChecksumBackup, { force: true });
  publicationReplacementStarted = false;
}

function dockerResourceLockPort() {
  const engineId = run("docker", ["info", "--format", "{{.ID}}"], { capture: true });
  const key = createHash("sha256").update(engineId).digest().readUInt16BE(0);
  return 49_152 + (key % 8_192);
}

function outputDirectoryLockPort(path) {
  const key = createHash("sha256").update(resolve(path)).digest().readUInt16BE(0);
  return 57_344 + (key % 8_192);
}

function acquireOutputDirectoryLock(path) {
  const server = createServer();
  const port = outputDirectoryLockPort(path);
  return new Promise((resolveLock, reject) => {
    server.once("error", (error) =>
      reject(error instanceof Error ? error : new Error(String(error))),
    );
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => resolveLock(server));
  });
}

function acquireDockerResourceLock() {
  const server = createServer();
  const port = dockerResourceLockPort();
  return new Promise((resolveLock, reject) => {
    server.once("error", (error) =>
      reject(error instanceof Error ? error : new Error(String(error))),
    );
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => resolveLock(server));
  });
}

function releaseDockerResourceLock(server) {
  return new Promise((resolveClose, reject) => {
    server.close((error) =>
      error
        ? reject(new Error("Failed to release Docker build lock", { cause: error }))
        : resolveClose(),
    );
  });
}

const options = readArgs(process.argv.slice(2));
if (options.allowDirty && options.exportImage) {
  throw new Error("--allow-dirty requires --no-export; dirty transfer artifacts are forbidden");
}
const aptSources = options.aptSources;
if (typeof aptSources === "string" && !existsSync(aptSources)) {
  throw new Error(`APT sources file does not exist: ${aptSources}`);
}
const pipConfig = options.pipConfig;
if (options.exportImage && typeof pipConfig !== "string") {
  throw new Error(
    `Transfer builds require a sandbox pip config at ${defaultPipConfigPath} or --pip-config <path>`,
  );
}
if (typeof pipConfig === "string" && !existsSync(pipConfig)) {
  throw new Error(`pip config file does not exist: ${pipConfig}`);
}
if (
  typeof pipConfig === "string" &&
  /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/iu.test(readFileSync(pipConfig, "utf8"))
) {
  throw new Error("pip config must not contain credentials embedded in repository URLs");
}
const pipConfigSha = typeof pipConfig === "string" ? await sha256File(pipConfig) : undefined;

run("docker", ["version"]);
run("docker", ["buildx", "version"]);

const gitCommit = run("git", ["-c", `safe.directory=${repoRoot}`, "rev-parse", "HEAD"], {
  capture: true,
});
const dirty = run("git", ["-c", `safe.directory=${repoRoot}`, "status", "--porcelain"], {
  capture: true,
});
if (dirty && !options.allowDirty) {
  throw new Error("Refusing to build a transfer artifact from a dirty working tree");
}

const packageVersion = JSON.parse(
  run("node", ["-p", "JSON.stringify(require('./package.json').version)"], { capture: true }),
);
const version = options.version ?? packageVersion;
if (!/^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(version)) {
  throw new Error(`Invalid image version: ${version}`);
}

const shortSha = gitCommit.slice(0, 12);
const timestamp = new Date().toISOString();
const jammyBuildImage = `platformclaw-jammy-build:${shortSha}`;
const openclawBuildImage = `platformclaw-openclaw-build:${shortSha}`;
const assetsImage = `platformclaw-runtime-assets:${shortSha}`;
const controlAssetsImage = `platformclaw-control-assets:${shortSha}`;
const runtimeVersionTag = `platformclaw:${version}`;
const runtimeShaTag = `platformclaw:${shortSha}`;
const sandboxVersionTag = `platformclaw-sandbox:${version}`;
const sandboxShaTag = `platformclaw-sandbox:${shortSha}`;
const secretArgs =
  typeof aptSources === "string"
    ? ["--secret", `id=platformclaw_apt_sources,src=${aptSources}`]
    : [];
const sandboxSecretArgs = [
  ...secretArgs,
  ...(typeof pipConfig === "string"
    ? ["--secret", `id=platformclaw_pip_config,src=${pipConfig}`]
    : []),
];
const extensions = [
  ...new Set([
    "admin-http-rpc",
    "knox",
    "platformclaw-execution",
    "platformclaw-web-relay",
    "platformclaw-user-mcp",
    ...options.extensions.split(/[\s,]+/u),
  ]),
]
  .filter(Boolean)
  .join(",");

function cleanupAfterBuild(buildSucceeded, recoverPublications = false) {
  const cleanupArgs = [
    resolve(repoRoot, "scripts", "platformclaw-dev-cleanup.mjs"),
    "--apply",
    "--intermediate-sha",
    shortSha,
    "--output-dir",
    options.outputDir,
    "--skip-cache",
    "--build-lock-owner",
    String(process.pid),
  ];
  if (!buildSucceeded) {
    cleanupArgs.push("--skip-final-images");
  }
  if (recoverPublications) {
    cleanupArgs.push("--recover-publications");
  }
  console.log(`> ${process.execPath} ${cleanupArgs.join(" ")}`);
  const result = spawnSync(process.execPath, cleanupArgs, { cwd: repoRoot, stdio: "inherit" });
  if (result.error || result.status !== 0) {
    console.warn(
      `PlatformClaw development cleanup failed; run pnpm platformclaw:dev-cleanup --apply (${result.error?.message ?? `exit ${result.status}`})`,
    );
  }
}

let buildSucceeded = false;
const buildLock = await acquireDockerResourceLock();
let publicationLockPath;
let publicationLockOwner;
let publicationCommitted = false;
let publicationCommitMarker;
let publicationArtifactPath;
let publicationChecksumPath;
let publicationArtifactBackup;
let publicationChecksumBackup;
let publicationReplacementStarted = false;
let publicationDirectoryLock;
let previousRuntimeShaId;
let previousSandboxShaId;
let shaSnapshotComplete = false;
let previousRuntimeId;
let previousSandboxId;
let versionSnapshotComplete = false;
try {
  previousRuntimeShaId = optionalImageId(runtimeShaTag);
  previousSandboxShaId = optionalImageId(sandboxShaTag);
  shaSnapshotComplete = true;
  run("docker", [
    "buildx",
    "build",
    "--load",
    "--target",
    "platformclaw-jammy-node",
    "-f",
    "Dockerfile.jammy",
    ...secretArgs,
    "-t",
    jammyBuildImage,
    ".",
  ]);

  run("docker", [
    "buildx",
    "build",
    "--load",
    "--target",
    "runtime-assets",
    "--build-context",
    `platformclaw-jammy-build=docker-image://${jammyBuildImage}`,
    "--build-arg",
    "OPENCLAW_BUILD_IMAGE=platformclaw-jammy-build",
    "--build-arg",
    `OPENCLAW_EXTENSIONS=${extensions}`,
    "--build-arg",
    `GIT_COMMIT=${gitCommit}`,
    "--build-arg",
    `OPENCLAW_BUILD_TIMESTAMP=${timestamp}`,
    "-t",
    assetsImage,
    ".",
  ]);

  // Reuse the cached pre-prune build stage so PlatformClaw private packages can
  // be built without adding downstream commands to the upstream Dockerfile.
  run("docker", [
    "buildx",
    "build",
    "--load",
    "--target",
    "build",
    "--build-context",
    `platformclaw-jammy-build=docker-image://${jammyBuildImage}`,
    "--build-arg",
    "OPENCLAW_BUILD_IMAGE=platformclaw-jammy-build",
    "--build-arg",
    `OPENCLAW_EXTENSIONS=${extensions}`,
    "--build-arg",
    `GIT_COMMIT=${gitCommit}`,
    "--build-arg",
    `OPENCLAW_BUILD_TIMESTAMP=${timestamp}`,
    "-t",
    openclawBuildImage,
    ".",
  ]);

  run("docker", [
    "buildx",
    "build",
    "--load",
    "--build-context",
    `openclaw-build=docker-image://${openclawBuildImage}`,
    "-f",
    "docker/platformclaw-runtime/Dockerfile.assets",
    "-t",
    controlAssetsImage,
    ".",
  ]);

  run("docker", [
    "buildx",
    "build",
    "--load",
    "-f",
    "Dockerfile.jammy",
    "--build-context",
    `openclaw-runtime=docker-image://${assetsImage}`,
    "--build-context",
    `platformclaw-control-assets=docker-image://${controlAssetsImage}`,
    ...secretArgs,
    "-t",
    runtimeShaTag,
    ".",
  ]);

  run("docker", [
    "buildx",
    "build",
    "--load",
    "-f",
    "Dockerfile.sandbox.jammy",
    ...sandboxSecretArgs,
    "-t",
    sandboxShaTag,
    ".",
  ]);

  run("docker", [
    "run",
    "--rm",
    "--entrypoint",
    "bash",
    runtimeShaTag,
    "-lc",
    [
      "grep -qx 'VERSION_ID=\"22.04\"' /etc/os-release",
      "node --version",
      "pnpm --version",
      "gh --version",
      "docker --version",
      "(docker compose version || docker-compose --version)",
      "ssh -V 2>&1 | grep -q OpenSSH",
      "sshpass -V | grep -q 'sshpass 1.'",
      "codex-acp --version",
      "claude-agent-acp --help >/dev/null",
      "claude --version",
      "nano-pdf --help >/dev/null",
      "openclaw --version",
      "test -x /usr/local/bin/platformclaw-admin",
      "test -x /usr/local/bin/platformclaw-control",
      "test -x /usr/local/bin/platformclaw-sshpass",
      "test -f /app/ui/dist/platformclaw-login.html",
      "node -e \"import('/app/packages/platformclaw-control-plane/dist/index.mjs')\"",
    ].join(" && "),
  ]);
  run("docker", [
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--user",
    "1003:1003",
    "--env",
    "HOME=/tmp/platformclaw-home",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,mode=1777",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    runtimeShaTag,
    "bash",
    "-ceu",
    [
      'test "$(id -u)" = 1003',
      'test "$(id -g)" = 1003',
      'test "$(id -un)" = platformclaw-1003',
      'test "$(id -gn)" = platformclaw-1003',
      "getent passwd 1003 | grep -q '^platformclaw-1003:x:1003:1003:'",
      "getent group 1003 | grep -q '^platformclaw-1003:x:1003:'",
      "ssh -G -F /dev/null platformclaw.invalid >/dev/null",
    ].join(" && "),
  ]);
  run("docker", [
    "run",
    "--rm",
    sandboxShaTag,
    "bash",
    "-lc",
    [
      "grep -qx 'VERSION_ID=\"22.04\"' /etc/os-release",
      "jq --version",
      "rg --version",
      'test "$(readlink -f /usr/bin/python)" = /usr/bin/python3.10',
      "python -c 'import markdown, markdownify, pygments, urllib3'",
      pipConfigSha
        ? `printf '%s  %s\\n' '${pipConfigSha}' /etc/pip.conf | sha256sum -c - && python3 -m pip config list >/dev/null`
        : "test ! -e /etc/pip.conf",
    ].join(" && "),
  ]);

  if (options.exportImage) {
    mkdirSync(options.outputDir, { recursive: true });
    const artifactName = `platformclaw-${version}-${shortSha}.tar`;
    const artifactPath = resolve(options.outputDir, artifactName);
    const checksumPath = `${artifactPath}.sha256`;
    publicationLockPath = `${artifactPath}.lock`;
    const artifactTemp = `${artifactPath}.tmp-${process.pid}`;
    const checksumTemp = `${checksumPath}.tmp-${process.pid}`;
    try {
      publicationDirectoryLock = await acquireOutputDirectoryLock(options.outputDir);
      // A prior process may have died after taking the publication lock. Recover it
      // under the build lock so same-SHA retries do not require manual maintenance.
      if (existsSync(publicationLockPath)) {
        cleanupAfterBuild(false, true);
      }
      previousRuntimeId = optionalImageId(runtimeVersionTag);
      previousSandboxId = optionalImageId(sandboxVersionTag);
      versionSnapshotComplete = true;
      publicationLockOwner = publishOwnedLock(publicationLockPath, {
        hadArtifact: existsSync(artifactPath),
        hadChecksum: existsSync(checksumPath),
        candidateRuntimeId: optionalImageId(runtimeShaTag),
        candidateSandboxId: optionalImageId(sandboxShaTag),
        runtimeVersionTag,
        sandboxVersionTag,
        previousRuntimeId: previousRuntimeId ?? null,
        previousSandboxId: previousSandboxId ?? null,
      });
      publicationCommitMarker = `${publicationLockPath}.committed-${publicationLockOwner.token}`;
      publicationArtifactPath = artifactPath;
      publicationChecksumPath = checksumPath;
      publicationArtifactBackup = `${artifactPath}.backup-${publicationLockOwner.token}`;
      publicationChecksumBackup = `${checksumPath}.backup-${publicationLockOwner.token}`;
      run("docker", ["save", "-o", artifactTemp, runtimeShaTag, sandboxShaTag]);
      const digest = await sha256File(artifactTemp);
      writeFileSync(checksumTemp, `${digest}  ${basename(artifactPath)}\n`, "utf8");
      publicationReplacementStarted = true;
      if (existsSync(artifactPath)) {
        renameSync(artifactPath, publicationArtifactBackup);
      }
      if (existsSync(checksumPath)) {
        renameSync(checksumPath, publicationChecksumBackup);
      }
      renameSync(artifactTemp, artifactPath);
      renameSync(checksumTemp, checksumPath);
    } finally {
      rmSync(artifactTemp, { force: true });
      rmSync(checksumTemp, { force: true });
    }
    console.log(`Created ${artifactPath}`);
    console.log(`Created ${checksumPath}`);
  }

  if (!versionSnapshotComplete) {
    previousRuntimeId = optionalImageId(runtimeVersionTag);
    previousSandboxId = optionalImageId(sandboxVersionTag);
    versionSnapshotComplete = true;
  }

  // The commit marker makes post-promotion lock cleanup recoverable without deleting the release.
  try {
    run("docker", ["image", "tag", runtimeShaTag, runtimeVersionTag]);
    run("docker", ["image", "tag", sandboxShaTag, sandboxVersionTag]);
    if (publicationLockOwner) {
      writeFileSync(publicationCommitMarker, `${JSON.stringify(publicationLockOwner)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      publicationCommitted = true;
    }
  } catch (error) {
    const failures = [error];
    for (const [tag, imageId] of [
      [runtimeVersionTag, previousRuntimeId],
      [sandboxVersionTag, previousSandboxId],
    ]) {
      try {
        restoreImageTag(tag, imageId);
      } catch (rollbackError) {
        failures.push(rollbackError);
      }
    }
    try {
      rollbackPublicationFiles();
    } catch (rollbackError) {
      failures.push(rollbackError);
    }
    throw failures.length === 1
      ? error
      : new AggregateError(failures, "Image promotion rollback failed");
  }

  if (publicationLockOwner) {
    try {
      discardPublicationBackups();
      removeOwnedLock(publicationLockPath, publicationLockOwner);
      publicationLockOwner = undefined;
      rmSync(publicationCommitMarker, { force: true });
    } catch (error) {
      console.warn(`Release publication committed; deferred lock cleanup: ${error.message}`);
    }
  }

  console.log(`PlatformClaw images ready: ${runtimeVersionTag}, ${sandboxVersionTag}`);
  buildSucceeded = true;
} finally {
  try {
    if (!buildSucceeded && shaSnapshotComplete) {
      for (const [tag, previousId] of [
        [runtimeShaTag, previousRuntimeShaId],
        [sandboxShaTag, previousSandboxShaId],
      ]) {
        let failedImageId;
        try {
          failedImageId = optionalImageId(tag);
          restoreImageTag(tag, previousId);
        } catch (error) {
          console.warn(`Failed to restore validated SHA tag ${tag}: ${error.message}`);
        }
        removeDanglingImage(failedImageId, previousId);
      }
    }
    if (publicationLockOwner) {
      if (!publicationCommitted) {
        rollbackPublicationFiles();
      } else {
        discardPublicationBackups();
      }
      try {
        removeOwnedLock(publicationLockPath, publicationLockOwner);
        rmSync(publicationCommitMarker, { force: true });
      } catch (error) {
        console.warn(`Deferred release publication cleanup: ${error.message}`);
      }
    }
    cleanupAfterBuild(buildSucceeded, Boolean(publicationDirectoryLock));
  } finally {
    try {
      if (publicationDirectoryLock) {
        await releaseDockerResourceLock(publicationDirectoryLock);
      }
    } finally {
      await releaseDockerResourceLock(buildLock);
    }
  }
}
