import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderKnoxReplyText } from "./reply-text.js";

const { resolvePinnedHostnameWithPolicy } = vi.hoisted(() => ({
  resolvePinnedHostnameWithPolicy: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/ssrf-runtime")>(
    "openclaw/plugin-sdk/ssrf-runtime",
  );
  return { ...actual, resolvePinnedHostnameWithPolicy };
});

beforeEach(() => {
  resolvePinnedHostnameWithPolicy.mockReset();
  resolvePinnedHostnameWithPolicy.mockResolvedValue({ addresses: ["93.184.216.34"] });
});

describe("renderKnoxReplyText", () => {
  it("preserves text and renders presentation commands, choices, and tables", async () => {
    expect(
      await renderKnoxReplyText({
        text: "작업 결과",
        presentation: {
          title: "선택",
          blocks: [
            { type: "context", text: "계속 진행할 방법" },
            {
              type: "buttons",
              buttons: [
                { label: "상태", action: { type: "command", command: "/status" } },
                { label: "선택지", action: { type: "callback", value: "private-callback" } },
              ],
            },
            { type: "select", placeholder: "대상", options: [{ label: "서버", value: "secret" }] },
            { type: "table", caption: "결과", headers: ["항목"], rows: [["완료"]] },
          ],
        },
      }),
    ).toBe(
      "작업 결과\n\n선택\n\n계속 진행할 방법\n\n- 상태: `/status`\n- 선택지\n\n대상:\n- 서버\n\n결과 (table)\n- 항목: 완료",
    );
  });

  it.each([undefined, "fallback"] as const)(
    "does not duplicate exact presentation fallback: %s",
    async (mode) => {
      expect(
        await renderKnoxReplyText({
          text: "어디에 배포할까요?",
          presentation: { blocks: [{ type: "text", text: "어디에 배포할까요?" }] },
          presentationTextMode: mode,
        }),
      ).toBe("어디에 배포할까요?");
    },
  );

  it("renders legacy controls and fallbackText without exposing callback values", async () => {
    expect(
      await renderKnoxReplyText({
        fallbackText: { text: "작업을 선택하세요" },
        interactive: {
          blocks: [{ type: "buttons", buttons: [{ label: "완료", value: "private" }] }],
        },
      }),
    ).toBe("작업을 선택하세요\n\n- 완료");
  });

  it("retains the caption and publicly resolved attachment link", async () => {
    expect(
      await renderKnoxReplyText({
        text: "생성했습니다.",
        mediaUrl: "https://example.com/report.pdf",
        attachments: [{ name: "보고서.pdf" }],
      }),
    ).toBe("생성했습니다.\n\n📎 첨부 파일 (보고서.pdf): https://example.com/report.pdf");
    expect(resolvePinnedHostnameWithPolicy).toHaveBeenCalledWith("example.com");
  });

  it("preserves public navigation while hiding internal control URLs", async () => {
    expect(
      await renderKnoxReplyText({
        presentation: {
          blocks: [
            {
              type: "buttons",
              buttons: [
                { label: "보고서", action: { type: "url", url: "https://example.com/report" } },
                { label: "내부 파일", url: "file:///private/report.pdf" },
                { label: "내부 앱", action: { type: "web-app", url: "http://10.0.0.1/app" } },
              ],
            },
          ],
        },
      }),
    ).toBe("- 보고서: https://example.com/report\n- 내부 파일\n- 내부 앱");
  });

  it.each([
    "/workspace/private/report.pdf",
    "C:\\private\\report.pdf",
    "file:///private/report.pdf",
    "https://user:password@example.com/report.pdf",
    "http://127.0.0.1/report.pdf",
    "http://192.168.1.1/report.pdf",
    "http://[::1]/report.pdf",
    "https://files.internal/report.pdf",
    "https://server/report.pdf",
  ])(
    "summarizes an inaccessible attachment without leaking its reference: %s",
    async (mediaUrl) => {
      expect(await renderKnoxReplyText({ mediaUrl })).toBe(
        "📎 첨부 파일: Knox에서는 직접 표시할 수 없습니다.",
      );
      expect(resolvePinnedHostnameWithPolicy).not.toHaveBeenCalled();
    },
  );

  it("hides media references when DNS resolves privately or media is sensitive", async () => {
    resolvePinnedHostnameWithPolicy.mockRejectedValueOnce(new Error("private address"));
    const expected = "📎 첨부 파일: Knox에서는 직접 표시할 수 없습니다.";
    expect(await renderKnoxReplyText({ mediaUrl: "https://example.com/private.pdf" })).toBe(
      expected,
    );
    expect(
      await renderKnoxReplyText({
        mediaUrl: "https://example.com/secret.pdf",
        sensitiveMedia: true,
      }),
    ).toBe(expected);
    expect(resolvePinnedHostnameWithPolicy).toHaveBeenCalledTimes(1);
  });

  it("handles attachment metadata alone and bounds large attachment lists", async () => {
    const rendered = await renderKnoxReplyText({
      attachments: Array.from({ length: 12 }, (_, index) => ({
        path: `/private/${index}`,
        name: `/private/${index}`,
      })),
    });
    expect(rendered?.split("\n")).toHaveLength(11);
    expect(rendered).not.toContain("/private/");
    expect(rendered).toContain("그 외 첨부 파일 2개가 있습니다.");
  });

  it("renders locations and leaves empty or opaque-only payloads empty", async () => {
    expect(
      await renderKnoxReplyText({ location: { latitude: 37.5, longitude: 127, name: "회사" } }),
    ).toBe("📍 위치\n회사\n37.5, 127");
    expect(await renderKnoxReplyText({})).toBeUndefined();
    expect(
      await renderKnoxReplyText({ channelData: { privateEnvelope: "secret" } }),
    ).toBeUndefined();
  });
});
