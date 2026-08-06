#!/usr/bin/env node

import { printSuccess, readText, requirePath } from "./submission-utils.mjs";

const html = readText("submission/slides/index.html");
requirePath("submission/slides/assets/platformclaw-mascot.svg");

const failures = [];
if (!/lang=["']ko["']/u.test(html)) {
  failures.push("document language must be Korean");
}
if (!/aspect-ratio\s*:\s*16\s*\/\s*9/iu.test(html)) {
  failures.push("slides must declare 16:9 aspect ratio");
}
if (!/platformclaw-mascot\.svg/u.test(html)) {
  failures.push("local mascot is not referenced");
}
if (!/image-rendering\s*:\s*pixelated/iu.test(html)) {
  failures.push("pixel mascot rendering policy is missing");
}
if (!/MOCK/u.test(html)) {
  failures.push("mock evidence is not visibly labeled");
}
if (/(?:src|href)\s*=\s*["'](?:https?:)?\/\//iu.test(html)) {
  failures.push("remote asset reference found");
}
if (/@import\s+url|<link[^>]+stylesheet|<script[^>]+src=/iu.test(html)) {
  failures.push("external stylesheet or script found");
}
if (/<iframe\b/iu.test(html)) {
  failures.push("iframe is not allowed for offline slides");
}
if (/display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:\D|$)/iu.test(html)) {
  failures.push("hidden content pattern found");
}
if (failures.length > 0) {
  throw new Error(failures.join("\n"));
}

printSuccess("offline slides", "local-only 16:9 deck");
