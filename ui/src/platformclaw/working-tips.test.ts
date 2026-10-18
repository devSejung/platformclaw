import { render } from "lit";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { RouteId } from "../app-route-paths.ts";
import { bootstrapApplication } from "../app/bootstrap.ts";
import { i18n } from "../i18n/index.ts";
import { renderChatWorkingIndicator } from "../pages/chat/components/chat-working-indicator.ts";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import { loadAllPlatformClawLocales, platformClawT as t } from "./i18n.ts";
import { createPlatformClawWorkingTip } from "./working-tips.ts";

const ROUTES: RouteId[] = [
  "new-session",
  "sessions",
  "skills",
  "skill-hub",
  "skill-workshop",
  "memory",
  "cron",
  "spaces",
];
const NOW = 2_000_000_000;
type PhraseElement = HTMLElement & { updateComplete: Promise<boolean> };

beforeAll(() => loadAllPlatformClawLocales());
afterEach(async () => {
  document.body.replaceChildren();
  vi.useRealTimers();
  await i18n.setLocale("en");
});

describe("PlatformClaw working tips", () => {
  it.each([
    [ROUTES, 15],
    [["memory"] as RouteId[], 8],
    [[] as RouteId[], 3],
  ] as const)("cycles every eligible tip before repeating with routes %j", (routes, count) => {
    const tip = createPlatformClawWorkingTip(routes);
    const regular = Array.from({ length: (count + 1) * 2 }, (_, rotation) => rotation)
      .filter((rotation) => rotation % 8 !== 7)
      .map((rotation) => tip("run:test", rotation));
    expect(new Set(regular.slice(0, count)).size).toBe(count);
    expect(regular[count]).toBe(regular[0]);
    expect(regular.every((text) => text && !text.startsWith("platformClaw."))).toBe(true);
    if (!routes.includes("spaces")) {
      expect(regular).not.toContain(t("platformClaw.waitingTips.space"));
    }
    expect(tip("run:test", 7)).not.toBe(tip("run:test", 15));
    expect([tip("run:test", 7), tip("run:test", 15)]).toEqual(
      expect.arrayContaining([
        t("platformClaw.waitingTips.gpu"),
        t("platformClaw.waitingTips.support"),
      ]),
    );
  });

  it("uses the approved Korean copy and translates the same selection after a locale change", async () => {
    const tip = createPlatformClawWorkingTip(ROUTES);
    await i18n.setLocale("ko");
    const korean = Array.from({ length: 24 }, (_, rotation) => tip("run:test", rotation));
    expect(new Set(korean).size).toBe(17);
    expect(korean).toContain("참고할 Wiki를 추가해 주세요.");
    expect(korean).toContain("Agent는 VM으로 출장 가도, 파일은 자동 동행하지 않아요.");
    expect(korean).toContain(
      "아무리 해도 안 풀리면 정승언에게 문의해 주세요. 숨겨진 마지막 도구입니다.",
    );
    expect(tip("run:test", 0)).toBe(korean[0]);
    await i18n.setLocale("en");
    expect(tip("run:test", 0)).not.toBe(korean[0]);
    expect(tip("run:test", 0)).not.toMatch(/[가-힣]/u);
  });

  it("renders through bootstrap and inherited chat context, rotates at 30 seconds, and releases timers", async () => {
    const tip = createPlatformClawWorkingTip(ROUTES);
    const runtime = bootstrapApplication({ chatWorkingTip: tip });
    const host = createApplicationContextProvider(runtime.context);
    document.body.append(host);
    vi.useFakeTimers({ now: NOW });
    try {
      render(
        renderChatWorkingIndicator({ kind: "reading-indicator", key: "run:test", startedAt: NOW }),
        host,
      );
      const phrase = host.querySelector<PhraseElement>("openclaw-working-phrase")!;
      await phrase.updateComplete;
      expect(phrase.textContent?.trim()).toBe("");
      await vi.advanceTimersByTimeAsync(30_000);
      await phrase.updateComplete;
      expect(phrase.textContent).toContain(tip("run:test", 0));
      expect(phrase.closest("[aria-hidden=true]")).toBeNull();
      expect(
        phrase.querySelector(".chat-working-indicator__tip")?.getAttribute("aria-hidden"),
      ).toBeNull();
      expect(host.querySelector("[role=status]")?.getAttribute("aria-live")).toBe("off");
      await vi.advanceTimersByTimeAsync(29_999);
      expect(phrase.textContent).toContain(tip("run:test", 0));
      await vi.advanceTimersByTimeAsync(1);
      await phrase.updateComplete;
      expect(phrase.textContent).toContain(tip("run:test", 1));
      render(null, host);
      expect(host.querySelector(".chat-working-indicator__tip")).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      host.remove();
      runtime.stop();
    }
  });

  it.each([
    { waitingApproval: true },
    { startupPhase: "starting_model" as const },
    { waitingSubagents: { startedAt: NOW } },
  ])("keeps actionable status ahead of tips: %j", (options) => {
    const host = document.createElement("div");
    render(
      renderChatWorkingIndicator(
        { kind: "reading-indicator", key: "run:test", startedAt: NOW },
        options,
      ),
      host,
    );
    expect(host.querySelector("openclaw-working-phrase")).toBeNull();
    expect(host.querySelector(".chat-working-indicator__status")?.textContent?.trim()).not.toBe("");
  });
});
