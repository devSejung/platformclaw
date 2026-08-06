#!/usr/bin/env node

import {
  printSuccess,
  readJsonYaml,
  readText,
  requirePath,
  runCommand,
  runNodeScript,
} from "./submission-utils.mjs";

runNodeScript("scripts/submission/verify-external.mjs");
runNodeScript("scripts/submission/check-internal-requirements.mjs", ["--final"]);

const evaluation = readJsonYaml("submission/evaluation-map.yaml");
const unresolved = evaluation.claims.filter(
  (claim) => claim.status === "INTERNAL_INTEGRATION_REQUIRED",
);
if (unresolved.length > 0) {
  throw new Error(
    `final gate has ${String(unresolved.length)} INTERNAL_INTEGRATION_REQUIRED claims`,
  );
}
const actualManifest = readJsonYaml("submission/evidence/actual-golden-run/manifest.json");
if (
  actualManifest?.mode !== "actual" ||
  actualManifest?.result !== "passed" ||
  !/^[a-f0-9]{40}$/u.test(actualManifest?.source_commit ?? "") ||
  typeof actualManifest?.run_id !== "string" ||
  typeof actualManifest?.correlation_id !== "string" ||
  !Array.isArray(actualManifest?.evidence_paths) ||
  actualManifest.evidence_paths.length === 0
) {
  throw new Error("actual Golden Run manifest is incomplete or not mode=actual");
}
runCommand("git", ["merge-base", "--is-ancestor", actualManifest.source_commit, "HEAD"]);

const requiredActualEvidence = [
  "submission/evidence/actual-golden-run/build-result.json",
  "submission/evidence/actual-golden-run/board-lease-result.json",
  "submission/evidence/actual-golden-run/board-validation-result.json",
  "submission/evidence/actual-golden-run/report-result.json",
  "submission/evidence/actual-golden-run/knox-result.json",
  "submission/evidence/actual-golden-run/verification-result.json",
  "submission/evidence/actual-golden-run/business-metrics.json",
  "submission/evidence/actual-golden-run/video-metadata.json",
];
const actualEvidencePaths = new Set(actualManifest.evidence_paths);
for (const path of requiredActualEvidence) {
  if (!actualEvidencePaths.has(path)) {
    throw new Error(`actual manifest is missing required evidence: ${path}`);
  }
}
if (
  !actualManifest.evidence_paths.some((path) =>
    /\/screenshots\/[^/]+\.(?:jpe?g|png|webp)$/iu.test(path),
  )
) {
  throw new Error("actual manifest must reference at least one sanitized screenshot");
}
for (const path of actualManifest.evidence_paths) {
  if (
    typeof path !== "string" ||
    !path.startsWith("submission/evidence/actual-golden-run/") ||
    path.includes("mock-golden-run")
  ) {
    throw new Error(`actual manifest contains an invalid evidence path: ${String(path)}`);
  }
  requirePath(path);
  if (path.endsWith(".json") && readJsonYaml(path)?.mode !== "actual") {
    throw new Error(`${path} is not explicitly marked mode=actual`);
  }
}

for (const path of [
  "submission/evidence/actual-golden-run/build-result.json",
  "submission/evidence/actual-golden-run/board-lease-result.json",
  "submission/evidence/actual-golden-run/board-validation-result.json",
  "submission/evidence/actual-golden-run/report-result.json",
  "submission/evidence/actual-golden-run/knox-result.json",
  "submission/evidence/actual-golden-run/verification-result.json",
]) {
  const evidence = readJsonYaml(path);
  if (evidence.result !== "passed") {
    throw new Error(`${path} does not record a passed actual result`);
  }
  if (evidence.run_id !== undefined && evidence.run_id !== actualManifest.run_id) {
    throw new Error(`${path} references a different run`);
  }
  if (
    evidence.correlation_id !== undefined &&
    evidence.correlation_id !== actualManifest.correlation_id
  ) {
    throw new Error(`${path} references a different correlation`);
  }
}

const boardValidation = readJsonYaml(
  "submission/evidence/actual-golden-run/board-validation-result.json",
);
if (
  JSON.stringify(boardValidation?.phases?.map((phase) => phase.phase)) !==
    JSON.stringify(["deploy", "boot", "validate", "cleanup"]) ||
  boardValidation.phases.some((phase) => phase.status !== "passed")
) {
  throw new Error("actual Board Farm evidence does not cover deploy, boot, validate, cleanup");
}
const actualVerification = readJsonYaml(
  "submission/evidence/actual-golden-run/verification-result.json",
);
if (
  actualVerification.run_id !== actualManifest.run_id ||
  !actualVerification.checks ||
  Object.values(actualVerification.checks).some((value) => value !== true)
) {
  throw new Error("actual verification checks are incomplete or failed");
}

const metrics = readJsonYaml("submission/evidence/actual-golden-run/business-metrics.json");
if (metrics?.mode !== "actual" || metrics?.measured !== true || !Array.isArray(metrics?.metrics)) {
  throw new Error("actual business metrics must be explicitly measured");
}
if (
  metrics.metrics.length === 0 ||
  metrics.metrics.some(
    (metric) =>
      !metric ||
      typeof metric.name !== "string" ||
      typeof metric.unit !== "string" ||
      typeof metric.value !== "number" ||
      !Number.isFinite(metric.value),
  )
) {
  throw new Error("actual business metrics contain an invalid measurement");
}

const video = readJsonYaml("submission/evidence/actual-golden-run/video-metadata.json");
if (
  video?.mode !== "actual" ||
  video?.container !== "mp4" ||
  typeof video?.duration_seconds !== "number" ||
  video.duration_seconds <= 0 ||
  video.duration_seconds > 300 ||
  typeof video?.video_codec !== "string" ||
  !Number.isSafeInteger(video?.width) ||
  !Number.isSafeInteger(video?.height) ||
  !/^[a-f0-9]{64}$/u.test(video?.sha256 ?? "")
) {
  throw new Error("final MP4 metadata is missing, invalid, or exceeds five minutes");
}

const serializedActualEvidence = actualManifest.evidence_paths
  .filter((path) => /\.(?:json|md|svg)$/iu.test(path))
  .map((path) => readText(path))
  .join("\n");
if (/"(?:accessToken|sessionToken|password|token)"\s*:/iu.test(serializedActualEvidence)) {
  throw new Error("actual evidence contains raw credential material");
}

printSuccess("final submission gate");
