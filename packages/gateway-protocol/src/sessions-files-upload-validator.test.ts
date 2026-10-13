import { describe, expect, it } from "vitest";
import { validateSessionsFilesUploadParams } from "./index.js";
import { MAX_TERMINAL_UPLOAD_BASE64_LENGTH } from "./schema/terminal-constants.js";

describe("session workspace upload protocol", () => {
  const params = { sessionKey: "agent:main:main", path: "", name: "data.bin", contentBase64: "" };

  it("accepts an empty file in the workspace root and an optional agent owner", () => {
    expect(validateSessionsFilesUploadParams(params)).toBe(true);
    expect(
      validateSessionsFilesUploadParams({ ...params, agentId: "main", path: "existing" }),
    ).toBe(true);
  });

  it.each([
    { ...params, sessionKey: "" },
    { ...params, name: "" },
    { ...params, path: undefined },
    { ...params, name: "x".repeat(256) },
    { ...params, contentBase64: "x".repeat(MAX_TERMINAL_UPLOAD_BASE64_LENGTH + 1) },
    { ...params, overwrite: true },
    { ...params, absoluteRoot: "/outside" },
  ])("rejects missing or unbounded fields and caller-controlled write policy", (value) => {
    expect(validateSessionsFilesUploadParams(value)).toBe(false);
  });
});
