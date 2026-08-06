#!/usr/bin/env node

import process from "node:process";
import { printSuccess, readJsonYaml, requirePath } from "./submission-utils.mjs";

const expectedIds = Array.from(
  { length: 13 },
  (_, index) => `IR-${String(index + 1).padStart(3, "0")}`,
);
const allowedStatuses = new Set([
  "VERIFIED_IMPLEMENTED",
  "IMPLEMENTED",
  "IMPLEMENTED_WITH_LIMITATIONS",
  "MOCK_VERIFIED",
  "INTERNAL_INTEGRATION_REQUIRED",
  "PROPOSED",
  "OUT_OF_SCOPE",
]);
const payload = readJsonYaml("submission/internal-requirements.yaml");
if (!payload || typeof payload !== "object" || !Array.isArray(payload.requirements)) {
  throw new Error("submission/internal-requirements.yaml must define a requirements array");
}

const ids = payload.requirements.map((requirement) => requirement?.id);
if (JSON.stringify(ids) !== JSON.stringify(expectedIds)) {
  throw new Error(`internal requirement ids must be ordered ${expectedIds.join(", ")}`);
}

const requiredFields = [
  "id",
  "summary",
  "status",
  "target_files",
  "required_internal_info",
  "secret_input",
  "commands",
  "expected_result",
  "failure_location",
  "evidence_paths",
  "docs_to_update",
  "final_gate_rule",
];
for (const requirement of payload.requirements) {
  for (const field of requiredFields) {
    if (!Object.hasOwn(requirement, field)) {
      throw new Error(`${requirement.id} is missing ${field}`);
    }
  }
  if (!allowedStatuses.has(requirement.status)) {
    throw new Error(`${requirement.id} has invalid status ${String(requirement.status)}`);
  }
  for (const field of ["target_files", "commands", "evidence_paths", "docs_to_update"]) {
    if (!Array.isArray(requirement[field]) || requirement[field].length === 0) {
      throw new Error(`${requirement.id}.${field} must be a non-empty array`);
    }
  }
  for (const targetPath of requirement.target_files.filter(
    (candidate) => !String(candidate).includes("<"),
  )) {
    requirePath(targetPath);
  }
  if (/token\s*[:=]\s*[A-Za-z0-9_-]{16,}/iu.test(JSON.stringify(requirement))) {
    throw new Error(`${requirement.id} appears to contain a secret value`);
  }
}

if (process.argv.includes("--final")) {
  const pending = payload.requirements.filter(
    (requirement) => requirement.status !== "VERIFIED_IMPLEMENTED",
  );
  if (pending.length > 0) {
    throw new Error(`final gate has ${String(pending.length)} pending internal requirements`);
  }
}

printSuccess("internal requirements", `${String(payload.requirements.length)} registered`);
