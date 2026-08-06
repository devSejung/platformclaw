#!/usr/bin/env node

import { printSuccess, readText, requirePath } from "./submission-utils.mjs";

const requiredFiles = [
  "README.md",
  "PRD.md",
  "ARCHITECTURE.md",
  "EVALUATION.md",
  "ATTRIBUTION.md",
  "PLATFORMCLAW.md",
  "docs/submission/README.md",
  ...Array.from({ length: 17 }, (_, index) =>
    index === 0
      ? "docs/submission/00_EVALUATION_REQUIREMENTS.md"
      : `docs/submission/${String(index).padStart(2, "0")}_${
          [
            "",
            "PRODUCT_SCOPE",
            "USER_SCENARIOS",
            "SECURITY_AND_ISOLATION",
            "CONTROL_PLANE_VM_SANDBOX",
            "KNOX_PERSONAL_GROUP_POLICY",
            "BOARD_FARM_MCP_CONTRACT",
            "GLOBAL_SKILLS_POLICY",
            "UI_UX_AND_THEME",
            "OPERATIONS_FAILURE_RECOVERY",
            "TESTING_AND_CI",
            "BUSINESS_VALUE",
            "CODE_MAP",
            "DECISIONS_AND_TRADEOFFS",
            "INTERNAL_HANDOFF",
            "DEMO_PLAN",
            "EXTERNAL_PREP_REPORT",
          ][index]
        }.md`,
  ),
  "submission/README.md",
  "submission/SUBMISSION_MANIFEST.md",
  "submission/evaluation-map.yaml",
  "submission/internal-requirements.yaml",
  "submission/INTERNAL_FINALIZATION_CHECKLIST.md",
  "submission/slides/index.html",
  "submission/video/README.md",
  "submission/video/FINAL_VIDEO_CHECKLIST.md",
];
for (const path of requiredFiles) {
  const absolutePath = requirePath(path);
  if (/\.(?:html|json|md|ya?ml)$/iu.test(path) && readText(path).trim().length < 80) {
    throw new Error(`required document is too small to be actionable: ${absolutePath}`);
  }
}

const canonicalDescription =
  "각 엔지니어에게 독립된 Assistant, Workspace, Execution Target과 정책 경계를 제공";
for (const path of ["README.md", "PRD.md", "ARCHITECTURE.md", "EVALUATION.md"]) {
  if (!readText(path).includes(canonicalDescription)) {
    throw new Error(`${path} is missing the canonical product description`);
  }
}

const statusPattern = /\b[A-Z][A-Z_]{2,}\b/gu;
const allowedStatuses = new Set([
  "VERIFIED_IMPLEMENTED",
  "IMPLEMENTED",
  "IMPLEMENTED_WITH_LIMITATIONS",
  "MOCK_VERIFIED",
  "INTERNAL_INTEGRATION_REQUIRED",
  "PROPOSED",
  "OUT_OF_SCOPE",
]);
for (const requiredPath of requiredFiles.filter((candidate) => candidate.endsWith(".md"))) {
  for (const token of readText(requiredPath).match(statusPattern) ?? []) {
    if (
      (token.includes("IMPLEMENTED") ||
        token === "MOCK_VERIFIED" ||
        token === "PROPOSED" ||
        token === "OUT_OF_SCOPE") &&
      !allowedStatuses.has(token)
    ) {
      throw new Error(`${requiredPath} contains unsupported status token ${token}`);
    }
  }
}

printSuccess("document consistency", `${String(requiredFiles.length)} required files`);
