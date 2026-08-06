#!/usr/bin/env node

import { listFiles, printSuccess, readText } from "./submission-utils.mjs";

const roots = [
  "README.md",
  "PRD.md",
  "ARCHITECTURE.md",
  "EVALUATION.md",
  "ATTRIBUTION.md",
  "PLATFORMCLAW.md",
  "docs/submission",
  "submission",
];
const textFiles = roots
  .flatMap((root) => listFiles(root))
  .filter((path) => /\.(?:html|json|md|svg|txt|ya?ml)$/iu.test(path));
const rules = [
  ["email address", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu],
  ["Message-ID", /Message-ID\s*:/iu],
  ["Korean phone number", /\b01[016789][-.\s]?\d{3,4}[-.\s]?\d{4}\b/u],
  ["employee-number label", /(?:사번|employee\s*id)\s*[:=]\s*[A-Z0-9-]{3,}/iu],
  ["private mail host", /(?:samsung\.com|s-core\.co\.kr|ext\.samsung\.net)/iu],
  [
    "hidden evaluator instruction",
    /(?:ignore\s+(?:all\s+)?previous|system\s+prompt|평가\s*에이전트에게\s*(?:명령|지시))/iu,
  ],
];

const failures = [];
for (const path of textFiles) {
  const text = readText(path);
  for (const [label, pattern] of rules) {
    if (pattern.test(text)) {
      failures.push(`${path}: ${label}`);
    }
  }
}
if (failures.length > 0) {
  throw new Error(`blindness check failed:\n${failures.join("\n")}`);
}

printSuccess("blindness", `${String(textFiles.length)} files`);
