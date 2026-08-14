#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, resolve } from "node:path";
import process from "node:process";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { patchTarModesFile } from "../../../../scripts/platformclaw-tar-modes.mjs";

const repoRoot = resolve(import.meta.dirname, "../../../..");

function fail(message) {
  throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`${command} exited with status ${result.status}`);
  return options.capture ? result.stdout.trim() : "";
}

function parseArgs(argv) {
  const options = { date: undefined, imageTar: undefined, outputDir: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (["--date", "--image-tar", "--output-dir"].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) fail(`${arg} requires a value`);
      options[arg.slice(2).replace(/-([a-z])/gu, (_, valuePart) => valuePart.toUpperCase())] =
        value;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: prepare-release.mjs --image-tar <path> --output-dir <path> --date YYYY-MM-DD",
      );
      process.exit(0);
    } else {
      fail(`Unknown argument: ${arg}`);
    }
  }
  if (!options.imageTar || !options.outputDir || !options.date) fail("Missing required options");
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(options.date)) fail("--date must use YYYY-MM-DD");
  const [year, month, day] = options.date.split("-").map(Number);
  const parsedDate = new Date(Date.UTC(year, month - 1, day));
  if (
    year < 2000 ||
    parsedDate.getUTCFullYear() !== year ||
    parsedDate.getUTCMonth() !== month - 1 ||
    parsedDate.getUTCDate() !== day
  ) {
    fail("--date must be a real calendar date");
  }
  return {
    date: options.date,
    imageTar: resolve(options.imageTar),
    outputDir: resolve(options.outputDir),
  };
}

function sha256(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

const options = parseArgs(process.argv.slice(2));
if (!existsSync(options.imageTar)) fail(`Image archive does not exist: ${options.imageTar}`);

const dirty = run("git", ["status", "--porcelain"], { capture: true });
if (dirty) fail("Refusing to prepare a release from a dirty working tree");
const fullSha = run("git", ["rev-parse", "HEAD"], { capture: true });
const shortSha = fullSha.slice(0, 12);
const version = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")).version;
const expectedImageName = `platformclaw-${version}-${shortSha}.tar`;
if (basename(options.imageTar) !== expectedImageName) {
  fail(`Expected image archive ${expectedImageName}, got ${basename(options.imageTar)}`);
}

mkdirSync(options.outputDir, { recursive: true });
const imageDigest = await sha256(options.imageTar);
const imageChecksum = `${options.imageTar}.sha256`;
writeFileSync(imageChecksum, `${imageDigest}  ${basename(options.imageTar)}\n`, "utf8");

const staging = mkdtempSync(resolve(options.outputDir, ".deployment-bundle-"));
const bundleFiles = [
  ["compose.yaml", false],
  ["platformclaw-compose", true],
  ["platformclaw-deploy", true],
  ["deployment.env.example", false],
  ["init-state", true],
  ["bootstrap-skillhub.mjs", true],
  ["migrate-workspace-owner", true],
  ["migrate-workspaces", true],
  ["SKILLHUB-LICENSE.txt", false],
  ["SKILLHUB-NOTICE.md", false],
  ["OPERATIONS.ko.md", false, "platformclaw-company-install-ko.md"],
];
try {
  for (const [sourceName, executable, targetName = sourceName] of bundleFiles) {
    const source = resolve(repoRoot, "docker/platformclaw-runtime", sourceName);
    const target = resolve(staging, targetName);
    if (!existsSync(source)) fail(`Deployment asset does not exist: ${source}`);
    copyFileSync(source, target);
  }

  const bundleName = `platformclaw-deployment-${version}-${shortSha}.tar.gz`;
  const bundlePath = resolve(options.outputDir, bundleName);
  const rawBundlePath = `${bundlePath}.tmp-${process.pid}`;
  try {
    run("tar", ["-cf", rawBundlePath, "--format=ustar", "-C", staging, "."]);
    const modes = new Map([
      [".", 0o755],
      ...bundleFiles.map(([sourceName, executable, targetName = sourceName]) => [
        targetName,
        executable ? 0o755 : 0o644,
      ]),
    ]);
    await patchTarModesFile(rawBundlePath, modes);
    await pipeline(createReadStream(rawBundlePath), createGzip(), createWriteStream(bundlePath));
  } finally {
    rmSync(rawBundlePath, { force: true });
  }
  const bundleDigest = await sha256(bundlePath);
  const bundleChecksum = `${bundlePath}.sha256`;
  writeFileSync(bundleChecksum, `${bundleDigest}  ${bundleName}\n`, "utf8");

  const tagName = `platformclaw-vm-preview-${options.date.replaceAll("-", "")}`;
  const title = `PlatformClaw VM Preview ${options.date}`;
  const notesPath = resolve(options.outputDir, "release-notes.md");
  writeFileSync(
    notesPath,
    `# PlatformClaw VM Preview (${options.date})\n\n` +
      `회사 환경 반입 전 검증용 prerelease입니다. 대상 commit은 \`${fullSha}\`입니다.\n\n` +
      "## 포함 내용\n\n- TODO\n\n" +
      "## 배포 자산\n\n" +
      `- \`${expectedImageName}\` 및 SHA-256 checksum\n` +
      `- \`${bundleName}\` 및 SHA-256 checksum\n` +
      "- `release-manifest.json`\n\n" +
      "## 검증\n\n- TODO\n\n" +
      "## 설치와 업데이트\n\n- TODO\n\n" +
      "## 주의\n\n- TODO\n",
    "utf8",
  );

  const asset = async (path) => ({
    name: basename(path),
    path,
    size: statSync(path).size,
    sha256: await sha256(path),
  });
  const localAssets = [];
  for (const path of [options.imageTar, imageChecksum, bundlePath, bundleChecksum]) {
    localAssets.push(await asset(path));
  }
  const assets = localAssets.map(({ name, sha256: digest, size }) => ({
    name,
    size,
    sha256: digest,
  }));
  const manifestPath = resolve(options.outputDir, "release-manifest.json");
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        schema: 1,
        kind: "vm-preview",
        tagName,
        title,
        targetCommit: fullSha,
        version,
        prerelease: true,
        notesFile: basename(notesPath),
        manifestFile: basename(manifestPath),
        assets,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const uploadPlanPath = resolve(options.outputDir, "release-upload-plan.local.json");
  writeFileSync(
    uploadPlanPath,
    `${JSON.stringify(
      {
        schema: 1,
        tagName,
        notesPath,
        uploadPaths: [...localAssets.map((entry) => entry.path), manifestPath],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(`Created ${bundlePath}`);
  console.log(`Created ${bundleChecksum}`);
  console.log(`Created ${manifestPath}`);
  console.log(`Created ${notesPath}`);
  console.log(`Created local upload plan ${uploadPlanPath}`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
