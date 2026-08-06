#!/usr/bin/env node

import { existsSync } from "node:fs";
import { printSuccess, readJsonYaml, resolveRepoPath } from "./submission-utils.mjs";

const ALLOWED_STATUSES = new Set([
  "VERIFIED_IMPLEMENTED",
  "IMPLEMENTED",
  "IMPLEMENTED_WITH_LIMITATIONS",
  "MOCK_VERIFIED",
  "INTERNAL_INTEGRATION_REQUIRED",
  "PROPOSED",
  "OUT_OF_SCOPE",
]);
const IMPLEMENTED_STATUSES = new Set([
  "VERIFIED_IMPLEMENTED",
  "IMPLEMENTED",
  "IMPLEMENTED_WITH_LIMITATIONS",
]);
const REQUIRED_FIELDS = [
  "id",
  "criterion",
  "status",
  "summary",
  "code_paths",
  "test_paths",
  "docs_paths",
  "mock_evidence_paths",
  "actual_evidence_paths",
  "limitations",
  "internal_requirement_id",
];

const payload = readJsonYaml("submission/evaluation-map.yaml");
if (!payload || typeof payload !== "object" || !Array.isArray(payload.claims)) {
  throw new Error("submission/evaluation-map.yaml must define a claims array");
}

const internal = readJsonYaml("submission/internal-requirements.yaml");
const internalIds = new Set(
  Array.isArray(internal?.requirements)
    ? internal.requirements.map((entry) => entry?.id).filter((value) => typeof value === "string")
    : [],
);
const claimIds = new Set();

for (const [index, claim] of payload.claims.entries()) {
  if (!claim || typeof claim !== "object" || Array.isArray(claim)) {
    throw new Error(`claim ${String(index)} must be an object`);
  }
  for (const field of REQUIRED_FIELDS) {
    if (!Object.hasOwn(claim, field)) {
      throw new Error(`claim ${String(index)} is missing ${field}`);
    }
  }
  if (typeof claim.id !== "string" || !claim.id.trim()) {
    throw new Error(`claim ${String(index)} has an invalid id`);
  }
  if (claimIds.has(claim.id)) {
    throw new Error(`duplicate claim id: ${claim.id}`);
  }
  claimIds.add(claim.id);
  if (!ALLOWED_STATUSES.has(claim.status)) {
    throw new Error(`${claim.id} has unsupported status: ${String(claim.status)}`);
  }
  if (typeof claim.summary !== "string" || !claim.summary.trim()) {
    throw new Error(`${claim.id} has an empty summary`);
  }
  if (typeof claim.limitations !== "string" || !claim.limitations.trim()) {
    throw new Error(`${claim.id} must state limitations explicitly`);
  }
  for (const field of [
    "code_paths",
    "test_paths",
    "docs_paths",
    "mock_evidence_paths",
    "actual_evidence_paths",
  ]) {
    if (!Array.isArray(claim[field])) {
      throw new Error(`${claim.id}.${field} must be an array`);
    }
    for (const path of claim[field]) {
      if (typeof path !== "string" || !existsSync(resolveRepoPath(path))) {
        throw new Error(`${claim.id}.${field} references a missing path: ${String(path)}`);
      }
    }
  }
  if (IMPLEMENTED_STATUSES.has(claim.status)) {
    if (claim.code_paths.length === 0 || claim.test_paths.length === 0) {
      throw new Error(`${claim.id} is implemented but lacks code or test evidence`);
    }
  }
  if (claim.status === "VERIFIED_IMPLEMENTED" && claim.actual_evidence_paths.length === 0) {
    throw new Error(`${claim.id} is verified but lacks actual runtime evidence`);
  }
  if (claim.status === "MOCK_VERIFIED" && claim.mock_evidence_paths.length === 0) {
    throw new Error(`${claim.id} is mock-verified but lacks mock evidence`);
  }
  if (
    claim.criterion === "completeness" &&
    claim.status === "VERIFIED_IMPLEMENTED" &&
    claim.actual_evidence_paths.length === 0
  ) {
    throw new Error(`${claim.id} completeness verification requires runtime evidence`);
  }
  if (claim.status === "INTERNAL_INTEGRATION_REQUIRED") {
    if (
      typeof claim.internal_requirement_id !== "string" ||
      !internalIds.has(claim.internal_requirement_id)
    ) {
      throw new Error(`${claim.id} must reference a registered internal requirement`);
    }
  } else if (claim.internal_requirement_id !== null && claim.internal_requirement_id !== "") {
    if (!internalIds.has(claim.internal_requirement_id)) {
      throw new Error(`${claim.id} references an unknown internal requirement`);
    }
  }
  if (claim.actual_evidence_paths.some((path) => path.includes("mock-golden-run"))) {
    throw new Error(`${claim.id} uses mock evidence as actual evidence`);
  }
}

printSuccess("evaluation map", `${String(payload.claims.length)} claims`);
