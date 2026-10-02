#!/usr/bin/env node
import { loadPlatformClawGuideVideoS3Config } from "./deployment-config.js";
import { probePlatformClawGuideVideoS3 } from "./guide-video-s3-probe.js";

async function main(): Promise<void> {
  const guideVideoS3 = loadPlatformClawGuideVideoS3Config(process.env);
  if (!guideVideoS3) {
    console.log("Private guide S3 preflight skipped: S3 mode is disabled.");
    return;
  }
  const result = await probePlatformClawGuideVideoS3(guideVideoS3);
  if (result.ok) {
    console.log(`Private guide S3 preflight OK: HTTP ${result.status}.`);
    return;
  }
  const detail = [result.status ? `HTTP ${result.status}` : undefined, result.code, result.message]
    .filter(Boolean)
    .join(" ");
  console.error(`Private guide S3 preflight failed: ${detail}`);
  process.exitCode = 2;
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Private guide S3 preflight failed: ${message}`);
  process.exitCode = 2;
});
