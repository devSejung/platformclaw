import { describe, expect, it } from "vitest";
import { localizeSkillHubCommandError } from "./skill-hub-command-errors.js";
import { SkillHubServiceError } from "./skill-hub-service-support.js";

describe("Skill Hub command error guidance", () => {
  it.each([
    ["skill-hub-vm-unavailable", 409, "선택한 VM을 사용할 수 없습니다"],
    ["skill-hub-publication-pending", 503, "원래 요청을 복구하거나 취소"],
    ["skill-hub-version-blocked", 409, "악성 코드가 확인되어 차단"],
    ["existing-skill-replacement-required", 409, "변경 내용을 확인하고 교체"],
    ["future-error", 400, "입력값과 명령어 사용법"],
  ] as const)("preserves authority and recovery details for %s", (code, status, guidance) => {
    const message = "Diagnostic bytes remain intact: {native: failed}";
    const details = {
      code,
      currentRevision: "sha256:1234567890abcdef",
      operationId: "original-operation",
    };
    const error = new SkillHubServiceError(message, status, details);
    expect(localizeSkillHubCommandError(error, "en")).toBe(error);
    const localized = localizeSkillHubCommandError(error, "ko");
    expect(localized).toBeInstanceOf(SkillHubServiceError);
    expect(localized.statusCode).toBe(status);
    expect(localized.message).toContain(guidance);
    expect(localized.message).toContain(`오류 정보: ${message}`);
    expect(localized.details).toEqual({ ...details, diagnostic: message });
    expect(error.message).toBe(message);
    expect(error.details).toBe(details);
  });
});
