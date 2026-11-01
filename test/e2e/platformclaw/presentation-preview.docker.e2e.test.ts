import { readFile } from "node:fs/promises";
import { z } from "zod";
import { defineDocumentPreviewScenarios } from "../../../ui/src/e2e/platformclaw-document-preview.test-support.ts";
import { createDocumentPreviewRuntime } from "./document-preview-runtime.ts";

// Run explicitly with vitest.ui-e2e.config.ts and OPENCLAW_VITEST_INCLUDE_FILE.
// A working rootless daemon and the canonical sandbox image are prerequisites.
const sshFixture = z
  .object({
    host: z.string(),
    port: z.number().int().positive(),
    publicKey: z.string(),
    password: z.string(),
  })
  .parse(JSON.parse(await readFile(".artifacts/document-preview-fixture/connection.json", "utf8")));

defineDocumentPreviewScenarios({
  formats: ["image", "pdf", "powerpoint"],
  sandboxImage: "platformclaw-document-preview:sandbox",
  createRuntime: (params) => createDocumentPreviewRuntime({ ...params, sshFixture }),
});
