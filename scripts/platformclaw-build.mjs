#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import process from "node:process";

const repoRoot = resolve(import.meta.dirname, "..");

/**
 * @typedef {object} BuildOptions
 * @property {boolean} allowDirty
 * @property {string | undefined} aptSources
 * @property {boolean} exportImage
 * @property {string} extensions
 * @property {string} outputDir
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

const options = readArgs(process.argv.slice(2));
if (options.allowDirty && options.exportImage) {
  throw new Error("--allow-dirty requires --no-export; dirty transfer artifacts are forbidden");
}
const aptSources = options.aptSources;
if (typeof aptSources === "string" && !existsSync(aptSources)) {
  throw new Error(`APT sources file does not exist: ${aptSources}`);
}

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
const extensions = [...new Set(["admin-http-rpc", ...options.extensions.split(/[\s,]+/u)])]
  .filter(Boolean)
  .join(",");

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
  runtimeVersionTag,
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
  ...secretArgs,
  "-t",
  sandboxVersionTag,
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
    "codex-acp --version",
    "claude-agent-acp --help >/dev/null",
    "claude --version",
    "nano-pdf --help >/dev/null",
    "openclaw --version",
    "test -x /usr/local/bin/platformclaw-control",
    "test -f /app/ui/dist/platformclaw-login.html",
    "node -e \"import('/app/packages/platformclaw-control-plane/dist/index.mjs')\"",
  ].join(" && "),
]);
run("docker", [
  "run",
  "--rm",
  sandboxShaTag,
  "bash",
  "-lc",
  "grep -qx 'VERSION_ID=\"22.04\"' /etc/os-release && jq --version && rg --version",
]);

if (options.exportImage) {
  mkdirSync(options.outputDir, { recursive: true });
  const artifactName = `platformclaw-${version}-${shortSha}.tar`;
  const artifactPath = resolve(options.outputDir, artifactName);
  run("docker", ["save", "-o", artifactPath, runtimeVersionTag, sandboxVersionTag]);
  const digest = await sha256File(artifactPath);
  const checksumPath = `${artifactPath}.sha256`;
  writeFileSync(checksumPath, `${digest}  ${basename(artifactPath)}\n`, "utf8");
  console.log(`Created ${artifactPath}`);
  console.log(`Created ${checksumPath}`);
}

console.log(`PlatformClaw images ready: ${runtimeVersionTag}, ${sandboxVersionTag}`);
