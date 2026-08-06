#!/usr/bin/env node

import { printSuccess, readText, runNodeScript } from "./submission-utils.mjs";

const passes = [
  {
    name: "기술성",
    scripts: ["scripts/submission/check-evaluation-map.mjs"],
    files: [
      "ARCHITECTURE.md",
      "docs/submission/03_SECURITY_AND_ISOLATION.md",
      "docs/submission/10_TESTING_AND_CI.md",
    ],
  },
  {
    name: "창의성",
    scripts: ["scripts/submission/check-document-consistency.mjs"],
    files: [
      "ATTRIBUTION.md",
      "docs/submission/01_PRODUCT_SCOPE.md",
      "docs/submission/13_DECISIONS_AND_TRADEOFFS.md",
    ],
  },
  {
    name: "완성도",
    scripts: ["scripts/submission/check-offline-slides.mjs"],
    files: [
      "submission/evidence/mock-golden-run/SUMMARY.md",
      "docs/submission/08_UI_UX_AND_THEME.md",
      "docs/submission/09_OPERATIONS_FAILURE_RECOVERY.md",
    ],
  },
  {
    name: "비즈니스 가치",
    scripts: ["scripts/submission/check-internal-requirements.mjs"],
    files: ["docs/submission/11_BUSINESS_VALUE.md", "docs/submission/14_INTERNAL_HANDOFF.md"],
  },
  {
    name: "전달력",
    scripts: ["scripts/submission/check-blindness.mjs"],
    files: [
      "README.md",
      "EVALUATION.md",
      "submission/slides/index.html",
      "docs/submission/15_DEMO_PLAN.md",
    ],
  },
];

for (const pass of passes) {
  for (const script of pass.scripts) {
    runNodeScript(script);
  }
  for (const file of pass.files) {
    const text = readText(file);
    if (text.trim().length < 120) {
      throw new Error(`${pass.name}: ${file} lacks substantive content`);
    }
  }
  printSuccess(`review pass ${pass.name}`);
}
