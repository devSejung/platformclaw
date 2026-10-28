import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import { loadAllPlatformClawLocales } from "./i18n.ts";
import { loadPlatformClawSkillHubConfig, PlatformClawSkillHubRequestError } from "./skill-hub.ts";

afterEach(async () => {
  vi.unstubAllGlobals();
  await i18n.setLocale("en");
});

describe("Skill Hub localized request failures", () => {
  it.each([
    ["skill-hub-invalid-version", 400, "버전 번호를 1.0.0", "Use a version number"],
    ["skill-hub-vm-unassigned", 409, "할당된 VM이 없습니다", "No VM is assigned"],
    ["skill-hub-vm-not-ready", 409, "VM 연결 설정을 완료", "Finish connecting your VM"],
    [
      "skill-hub-vm-unavailable",
      409,
      "선택한 VM을 사용할 수 없습니다",
      "selected VM is unavailable",
    ],
    ["skill-hub-version-blocked", 409, "악성 코드가 확인되어 차단", "malware was confirmed"],
    [
      "skill-hub-version-unavailable",
      409,
      "아직 다운로드할 수 없는",
      "not available to download yet",
    ],
    ["skill-hub-publication-pending", 503, "원래 요청을 다시 시도", "Retry the original request"],
    ["skill-hub-changed", 409, "최신 정보를 불러온", "Load the latest information"],
  ] as const)(
    "keeps %s distinct through the HTTP boundary in both languages",
    async (code, status, ko, en) => {
      await loadAllPlatformClawLocales();
      const original = "Original diagnostic remains available";
      const details = { code, currentRevision: "revision-from-server" };
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify({ error: original, details }), { status })),
      );
      for (const [locale, expected] of [
        ["ko", ko],
        ["en", en],
      ] as const) {
        await i18n.setLocale(locale);
        await expect(loadPlatformClawSkillHubConfig()).rejects.toMatchObject({
          name: "PlatformClawSkillHubRequestError",
          status,
          details,
          serverMessage: original,
          message: expect.stringContaining(expected),
        });
        await expect(loadPlatformClawSkillHubConfig()).rejects.toThrow(original);
      }
    },
  );

  it("preserves unknown server diagnostics with localized guidance rather than parsing English", async () => {
    await loadAllPlatformClawLocales();
    await i18n.setLocale("ko");
    const original = "Unexpected package constraint: {keep-these-bytes}";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: original, details: { code: "future-code" } }), {
            status: 400,
          }),
      ),
    );
    await expect(loadPlatformClawSkillHubConfig()).rejects.toMatchObject({
      status: 400,
      serverMessage: original,
      details: { code: "future-code" },
      message: expect.stringContaining("입력한 값과 스킬 패키지를 확인"),
    });
    await expect(loadPlatformClawSkillHubConfig()).rejects.toThrow(`오류 정보: ${original}`);
  });

  it("keeps replacement confirmation details unchanged", async () => {
    const details = {
      code: "existing-skill-replacement-required",
      currentVersion: "1.0.0",
      requestedVersion: "2.0.0",
      currentRevision: "original-revision",
      direction: "upgrade",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "Confirm replacement", details }), { status: 409 }),
      ),
    );
    await expect(loadPlatformClawSkillHubConfig()).rejects.toMatchObject({ details, status: 409 });
  });

  it("explains an uncertain network result without losing its original diagnostic", async () => {
    await loadAllPlatformClawLocales();
    await i18n.setLocale("ko");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Connection lost after send");
      }),
    );
    await expect(loadPlatformClawSkillHubConfig()).rejects.toMatchObject({
      name: "PlatformClawSkillHubRequestError",
      status: 0,
      serverMessage: "Connection lost after send",
      message: expect.stringContaining("현재 처리 결과를 확인한 뒤 다시 시도"),
    });
    expect(new PlatformClawSkillHubRequestError("existing caller", 409).serverMessage).toBe(
      "existing caller",
    );
  });
});
