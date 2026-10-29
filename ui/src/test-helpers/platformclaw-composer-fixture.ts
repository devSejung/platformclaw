import type { Browser, Page } from "playwright";
import { installMockGateway, type ControlUiE2eServer } from "./control-ui-e2e.ts";
import {
  createPlatformClawMemoryContext,
  installPlatformClawMemoryDocument,
  platformClawMemoryAgentId,
} from "./platformclaw-memory-fixture.ts";

/** Development/test fixture only. Nothing here is imported by the product bundle. */
export async function openComposerPredictionFixture(params: {
  browser: Browser;
  server: ControlUiE2eServer;
  options: Parameters<typeof createPlatformClawMemoryContext>[2];
}) {
  const { browser, server, options } = params;
  const context = await createPlatformClawMemoryContext(browser, server.baseUrl, options);
  const page = await context.newPage();
  page.on("domcontentloaded", () => {
    void installDemoControls(page);
  });
  await installPlatformClawMemoryDocument(page, server.baseUrl);
  await page.route("**/platformclaw/api/announcements", (route) =>
    route.fulfill({
      json: { revision: 0, serverNow: Date.now(), announcement: null },
    }),
  );
  let enabled = false;
  let mode = "success";
  let predictionCalls = 0;
  const gateway = await installMockGateway(page, {
    assistantName: "PlatformClaw",
    basePath: "/platformclaw/app",
    defaultAgentId: platformClawMemoryAgentId,
    models: [{ id: "codellm-fast", name: "Fast · ornith-1.5-35b", provider: "codemate" }],
    methodResponses: { "platformclaw.spaces.list": [] },
  });
  await page.route("**/platformclaw/api/composer-predictions", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    if (body.action === "preferences") {
      if (typeof body.enabled === "boolean") {
        enabled = body.enabled;
      }
      await route.fulfill({ json: { available: true, enabled, timeoutMs: 10_000 } });
      return;
    }
    predictionCalls++;
    const delay = mode === "delay" ? 4000 : mode === "timeout" ? 11_000 : 0;
    if (delay) {
      await new Promise((resolve) => {
        setTimeout(resolve, delay);
      });
    }
    await route
      .fulfill({
        json: {
          text:
            enabled && mode !== "busy" && mode !== "timeout"
              ? "구체적인 실행 방법을 예시로 알려줘"
              : null,
        },
      })
      .catch(() => undefined);
  });
  await page.exposeFunction("composerDemoMode", (next: string) => {
    mode = next;
  });
  await page.goto(`${server.baseUrl}platformclaw/app/chat/${platformClawMemoryAgentId}/main`, {
    waitUntil: "domcontentloaded",
  });
  await page.locator(".agent-chat__composer-combobox textarea").waitFor({ timeout: 60_000 });
  const seen = new Set<string>();
  let polling = false;
  const timer = setInterval(() => {
    if (polling || page.isClosed()) {
      return;
    }
    polling = true;
    void gateway
      .getRequests("chat.send")
      .then(async (requests) => {
        for (const request of requests) {
          const body = request.params as Record<string, unknown>;
          const runId = String(body.idempotencyKey);
          if (seen.has(runId)) {
            continue;
          }
          seen.add(runId);
          await gateway.emitChatFinal({
            runId,
            sessionKey: String(body.sessionKey),
            text: "[MOCK] 계획을 세 단계로 정리했습니다. 입력창의 추천은 자동 전송되지 않습니다.",
          });
        }
      })
      .catch(() => undefined)
      .finally(() => {
        polling = false;
      });
  }, 250);
  context.once("close", () => clearInterval(timer));
  return { context, page, gateway, predictionCalls: () => predictionCalls };
}

async function installDemoControls(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (document.querySelector("[data-composer-demo]")) {
      return;
    }
    const panel = document.createElement("aside");
    panel.dataset.composerDemo = "true";
    panel.style.cssText =
      "position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:10000;background:#182631;color:white;padding:10px 18px;border:2px solid #eab308;border-radius:12px;font:13px sans-serif;box-shadow:0 4px 18px #0004";
    panel.innerHTML = `<strong>개발 전용 MOCK · 실제 LLM 호출 없음</strong><br>
      Settings → Appearance에서 다음 프롬프트 예측을 켜고 채팅을 보내세요.<br>
      <label>시나리오 <select aria-label="Mock prediction scenario" style="color:#182631;background:#fff">
        <option value="success">정상 성공</option><option value="delay">4초 지연</option>
        <option value="timeout">10초 타임아웃</option><option value="busy">모델 바쁨: 생략</option>
      </select></label> · 지연 중 타이핑 / Tab / Escape / 세션 이동을 직접 확인`;
    panel.querySelector("select")?.addEventListener("change", (event) => {
      const host = window as Window & { composerDemoMode?: (mode: string) => Promise<void> };
      if (!host.composerDemoMode) {
        throw new Error("Composer fixture mode callback is missing");
      }
      void host.composerDemoMode((event.target as HTMLSelectElement).value);
    });
    document.body.append(panel);
  });
}
