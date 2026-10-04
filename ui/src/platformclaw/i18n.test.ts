import { afterEach, describe, expect, it } from "vitest";
import { i18n, t } from "../i18n/index.ts";
import { loadLazyLocaleTranslation } from "../i18n/lib/registry.ts";
import {
  loadAllPlatformClawLocales,
  loadPlatformClawLocale,
  platformClawProductT,
  platformClawT,
} from "./i18n.ts";
import {
  PLATFORMCLAW_WEB_DESCRIPTOR,
  PLATFORMCLAW_WEB_DESCRIPTOR_META_NAME,
} from "./web-contract.ts";

function installDescriptor(): void {
  const descriptor = document.createElement("meta");
  descriptor.name = PLATFORMCLAW_WEB_DESCRIPTOR_META_NAME;
  descriptor.content = JSON.stringify(PLATFORMCLAW_WEB_DESCRIPTOR);
  document.head.append(descriptor);
}

describe("PlatformClaw product translations", () => {
  afterEach(() => {
    document.head.querySelector(`meta[name="${PLATFORMCLAW_WEB_DESCRIPTOR_META_NAME}"]`)?.remove();
    return i18n.setLocale("en");
  });

  it("uses the PlatformClaw Korean override and the English source on locale changes", async () => {
    await loadAllPlatformClawLocales();
    await i18n.setLocale("ko");
    expect(platformClawT("configView.appearance.terminalTextSize")).toBe("터미널 텍스트 크기");

    await i18n.setLocale("en");
    expect(platformClawT("configView.appearance.terminalTextSize")).toBe("Terminal text size");
  });

  it("loads native Korean controls alongside the core locale without replacing other copy", async () => {
    const base = await loadLazyLocaleTranslation("ko");
    const original = structuredClone(base);
    await Promise.all([i18n.setLocale("ko"), loadAllPlatformClawLocales()]);

    expect(t("execApproval.execApprovalNeeded")).toBe("명령 실행 승인 필요");
    expect(t("execApproval.allowOnce")).toBe("한 번 허용");
    expect(t("execApproval.alwaysAllow")).toBe("항상 허용");
    expect(t("execApproval.deny")).toBe("거부");
    expect(t("execApproval.labels.cwd")).toBe("작업 디렉터리");
    expect(t("execApproval.allowAlwaysUnavailable")).toBe("이 명령은 항상 허용할 수 없습니다.");
    expect(t("chat.waitingOnSubagents")).toBe("하위 에이전트 작업 대기 중");
    expect(t("chat.yieldWaiting")).toBe("작업을 맡기고 대기 중");
    expect(t("chat.yieldResumed")).toBe("재개됨");
    expect(t("chat.yieldFailed")).toBe("작업을 맡기지 못했습니다");
    expect(t("chat.runControls.sendMessage")).toBe("메시지 보내기");
    expect(t("chat.runControls.stopGenerating")).toBe("생성 중지");
    expect(t("execApproval.expiresIn", { time: "01:30" })).toBe("01:30 후 만료");
    expect(t("execApproval.reviewRequest", { agent: "도우미" })).toBe(
      "도우미의 승인 요청 검토: {command}",
    );
    expect(t("chat.composer.placeholder", { name: "OpenClaw test" })).toBe(
      "OpenClaw test에게 메시지 보내기",
    );
    for (const key of ["common.health", "chat.view.reasoning", "chat.composer.startVoiceInput"]) {
      const expected = key.split(".").reduce<unknown>((value, part) => {
        return value && typeof value === "object"
          ? (value as Record<string, unknown>)[part]
          : undefined;
      }, original);
      expect(t(key), key).toBe(expected);
      expect(platformClawT(key), key).toBe(t(key));
    }
    expect(platformClawT("missing.platformClaw.translation")).toBe(
      "missing.platformClaw.translation",
    );
    expect(base).toEqual(original);
  });

  it("retains native Korean copy across locale switches without changing other locales", async () => {
    await loadAllPlatformClawLocales();
    await i18n.setLocale("ko");
    await loadPlatformClawLocale();
    expect(t("execApproval.allowOnce")).toBe("한 번 허용");

    await i18n.setLocale("en");
    expect(t("execApproval.allowOnce")).toBe("Allow once");
    expect(t("chat.runControls.sendMessage")).toBe("Send message");
    expect(t("chat.waitingOnSubagents")).toBe("Waiting on subagents");
    expect(t("chat.yieldWaiting")).toBe("Handed off and waiting");
    expect(t("chat.yieldResumed")).toBe("Resumed");
    expect(t("chat.yieldFailed")).toBe("Could not hand off the turn");
    await i18n.setLocale("de");
    const germanLabel = t("execApproval.allowOnce");
    await loadAllPlatformClawLocales();
    expect(i18n.getLocale()).toBe("de");
    expect(t("execApproval.allowOnce")).toBe(germanLabel);
    await i18n.setLocale("ko");
    expect(t("chat.runControls.sendMessage")).toBe("메시지 보내기");
  });

  it("brands the trusted template without rewriting interpolated runtime data", () => {
    installDescriptor();

    expect(
      platformClawProductT("custodian.sessionRestarted", {
        error: "OpenClaw CLI failed.",
      }),
    ).toBe(
      "OpenClaw CLI failed. PlatformClaw started a fresh session; earlier messages remain for context.",
    );
  });
});
