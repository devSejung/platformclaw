import { describe, expect, it } from "vitest";
import { SessionsFilesDownloadResultSchema, validateSessionsFilesDownloadParams } from "./index.js";
import { lazyCompile } from "./protocol-validator.js";
import {
  MAX_TERMINAL_UPLOAD_BASE64_LENGTH,
  MAX_TERMINAL_UPLOAD_BYTES,
} from "./schema/terminal-constants.js";

const validateResult = lazyCompile(SessionsFilesDownloadResultSchema);
const params = { sessionKey: "agent:main:main", path: "folder/data.bin" };
const result = {
  sessionKey: params.sessionKey,
  file: {
    path: params.path,
    name: "data.bin",
    size: 0,
    mimeType: "application/octet-stream",
    contentBase64: "",
  },
};

describe("session workspace download protocol", () => {
  it("accepts a bounded path and optional agent, and returns empty binary files", () => {
    expect(validateSessionsFilesDownloadParams(params)).toBe(true);
    expect(validateSessionsFilesDownloadParams({ ...params, agentId: "main" })).toBe(true);
    expect(validateResult(result)).toBe(true);
  });

  it.each([
    { ...params, path: "" },
    { ...params, path: "x".repeat(4097) },
    { ...params, sessionKey: "" },
    { ...params, agentId: "" },
    { ...params, root: "/outside" },
    { ...params, maxBytes: Number.MAX_SAFE_INTEGER },
  ])("rejects missing fields and caller-controlled limits or roots", (value) => {
    expect(validateSessionsFilesDownloadParams(value)).toBe(false);
  });

  it.each([
    { ...result.file, size: MAX_TERMINAL_UPLOAD_BYTES + 1 },
    { ...result.file, contentBase64: "A".repeat(MAX_TERMINAL_UPLOAD_BASE64_LENGTH + 1) },
    { ...result.file, name: "" },
    { ...result.file, root: "/private" },
  ])("bounds and closes the response shape", (file) => {
    expect(validateResult({ ...result, file })).toBe(false);
  });
});
