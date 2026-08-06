#!/usr/bin/env node

import {
  printSuccess,
  readJsonYaml,
  readText,
  requirePath,
  runCommand,
  runNodeScript,
} from "./submission-utils.mjs";

for (const script of [
  "scripts/submission/check-document-consistency.mjs",
  "scripts/submission/check-evaluation-map.mjs",
  "scripts/submission/check-internal-requirements.mjs",
  "scripts/submission/check-offline-slides.mjs",
  "scripts/submission/check-blindness.mjs",
  "scripts/submission/self-review.mjs",
]) {
  runNodeScript(script);
}

const manifest = readJsonYaml("submission/evidence/mock-golden-run/manifest.json");
if (
  manifest?.mode !== "mock" ||
  manifest?.result !== "passed" ||
  !/^[a-f0-9]{40}$/u.test(manifest?.source_commit ?? "") ||
  typeof manifest?.run_id !== "string" ||
  typeof manifest?.correlation_id !== "string" ||
  typeof manifest?.generated_at !== "string" ||
  !Array.isArray(manifest?.commands) ||
  manifest.commands.length === 0 ||
  !Array.isArray(manifest?.evidence_paths) ||
  manifest.evidence_paths.length === 0
) {
  throw new Error("mock Golden Path manifest must be explicitly marked mode=mock and passed");
}
runCommand("git", ["merge-base", "--is-ancestor", manifest.source_commit, "HEAD"]);
for (const path of manifest.evidence_paths) {
  if (
    typeof path !== "string" ||
    !path.startsWith("submission/evidence/mock-golden-run/") ||
    path.includes("actual-golden-run")
  ) {
    throw new Error(`mock manifest contains an invalid evidence path: ${String(path)}`);
  }
  requirePath(path);
  if (path.endsWith(".json") && readJsonYaml(path)?.mode !== "mock") {
    throw new Error(`${path} is not explicitly marked mode=mock`);
  }
}
const verification = readJsonYaml("submission/evidence/mock-golden-run/verification-result.json");
if (
  verification?.mode !== "mock" ||
  verification?.result !== "passed" ||
  verification?.run_id !== manifest.run_id ||
  !verification?.checks ||
  Object.values(verification.checks).some((value) => value !== true)
) {
  throw new Error("mock verification result is missing or failed");
}
const validation = readJsonYaml("submission/evidence/mock-golden-run/board-validation-result.json");
if (
  validation?.result !== "passed" ||
  JSON.stringify(validation?.phases?.map((phase) => phase.phase)) !==
    JSON.stringify(["deploy", "boot", "validate", "cleanup"]) ||
  validation.phases.some((phase) => phase.status !== "passed")
) {
  throw new Error("mock Board Farm workflow evidence is incomplete");
}
const serializedEvidence = manifest.evidence_paths
  .filter((path) => /\.(?:json|md|svg)$/iu.test(path))
  .map((path) => readText(path))
  .join("\n");
if (/"(?:accessToken|sessionToken|password|token)"\s*:/iu.test(serializedEvidence)) {
  throw new Error("mock evidence contains raw credential material");
}

runCommand("git", ["diff", "--check"]);
printSuccess("external submission gate");
