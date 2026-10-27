import path from "node:path";
import { createServer, type Plugin } from "vite";
import { LOCALE_STORAGE_KEY } from "../ui/src/i18n/lib/locale-preferences.ts";
import { PLATFORMCLAW_WEB_DESCRIPTOR } from "../ui/src/platformclaw/web-contract.ts";
import {
  createControlUiMockBootstrapConfig,
  createControlUiMockGatewayInitScript,
} from "../ui/src/test-helpers/control-ui-e2e.ts";
import controlUiViteConfig from "../ui/vite.config.ts";

// Standalone development entry only: every document receives the fixture, so
// opening another browser or closing a tab cannot detach the mock from the UI.
const scenario = {
  assistantName: "PlatformClaw",
  basePath: "/platformclaw/app",
  defaultAgentId: "assigned-personal",
  models: [{ id: "codellm-fast", name: "Fast · ornith-1.5-35b", provider: "codemate" }],
  methodResponses: { "platformclaw.spaces.list": [] },
};
let enabled = false;
let mode = "success";

function installBrowserDemo(localeKey: string) {
  const origin = location.origin.replace(/^http/u, "ws");
  for (const suffix of ["", "/platformclaw/app", "/platformclaw/gateway"]) {
    const gatewayUrl = origin + suffix;
    localStorage.setItem(
      "openclaw.control.settings.v1:" + gatewayUrl,
      JSON.stringify({ gatewayUrl, theme: "platformclaw", themeMode: "light" }),
    );
  }
  localStorage.setItem(localeKey, "ko");
  document.addEventListener("DOMContentLoaded", () => {
    const panel = document.createElement("aside");
    panel.dataset.composerDemo = "true";
    panel.style.cssText =
      "position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:10000;background:#182631;color:white;padding:10px 18px;border:2px solid #eab308;border-radius:12px;font:13px sans-serif;box-shadow:0 4px 18px #0004";
    panel.innerHTML = `<strong>개발 전용 MOCK · 실제 LLM 호출 없음</strong><br>
      설정 → 화면 → 채팅 환경설정에서 다음 프롬프트 예측을 켜고 채팅을 보내세요.<br>
      <label>시나리오 <select aria-label="Mock prediction scenario" style="color:#182631;background:#fff">
      <option value="success">정상 성공</option><option value="delay">4초 지연</option>
      <option value="timeout">10초 타임아웃</option><option value="busy">모델 바쁨: 생략</option>
      </select></label> · Tab: 삽입 / Escape: 닫기 / 타이핑: 취소`;
    panel.querySelector("select")?.addEventListener("change", (event) => {
      void fetch("/__composer-demo/mode", {
        method: "POST",
        body: (event.target as HTMLSelectElement).value,
      });
    });
    document.body.append(panel);
  });
  const seen = new Set<string>();
  const timer = setInterval(() => {
    const gateway = (
      window as Window & {
        openclawControlUiE2eGateway?: {
          findRequests: (method: string) => { params?: Record<string, unknown> }[];
          emit: (event: string, payload: unknown) => void;
        };
      }
    ).openclawControlUiE2eGateway;
    for (const request of gateway?.findRequests("chat.send") ?? []) {
      const runId = String(request.params?.idempotencyKey);
      if (seen.has(runId)) {
        continue;
      }
      seen.add(runId);
      gateway?.emit("chat", {
        runId,
        sessionKey: String(request.params?.sessionKey),
        state: "final",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "[MOCK] 계획을 세 단계로 정리했습니다. 추천은 자동 전송되지 않습니다.",
            },
          ],
          timestamp: Date.now(),
        },
      });
    }
  }, 250);
  window.addEventListener("pagehide", () => clearInterval(timer), { once: true });
}

const demoPlugin: Plugin = {
  name: "platformclaw-composer-demo",
  apply: "serve",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      void (async () => {
        const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
        const json = (value: unknown) => {
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "no-store");
          res.end(JSON.stringify(value));
        };
        if (pathname.endsWith("/control-ui-config.json")) {
          json(createControlUiMockBootstrapConfig(scenario));
        } else if (pathname === "/platformclaw/api/auth/session") {
          json({
            authenticated: true,
            user: {
              accountId: "member.one",
              displayName: "Member One",
              department: "Platform",
              globalRole: "member",
            },
            agent: { agentId: "assigned-personal", state: "active" },
          });
        } else if (pathname === "/platformclaw/api/announcements") {
          json({ revision: 0, serverNow: Date.now(), announcement: null });
        } else if (
          pathname === "/__composer-demo/mode" ||
          pathname === "/platformclaw/api/composer-predictions"
        ) {
          let body = "";
          for await (const chunk of req) {
            body += String(chunk);
            if (body.length > 4096) {
              res.writeHead(413).end();
              return;
            }
          }
          if (pathname === "/__composer-demo/mode") {
            if (["success", "delay", "timeout", "busy"].includes(body)) {
              mode = body;
            }
            json({ mode });
            return;
          }
          let input: { action?: string; enabled?: boolean };
          try {
            input = JSON.parse(body);
          } catch {
            res.writeHead(400).end();
            return;
          }
          if (input.action === "preferences") {
            if (typeof input.enabled === "boolean") {
              enabled = input.enabled;
            }
            json({ available: true, enabled });
            return;
          }
          const currentMode = mode;
          const delay = currentMode === "delay" ? 4000 : currentMode === "timeout" ? 11_000 : 0;
          const timer = setTimeout(() => {
            json({
              text:
                enabled && currentMode !== "busy" && currentMode !== "timeout"
                  ? "구체적인 실행 방법을 예시로 알려줘"
                  : null,
            });
          }, delay);
          // Closing/aborting the browser request must also release the mock delay.
          res.once("close", () => clearTimeout(timer));
        } else {
          next();
        }
      })().catch(next);
    });
  },
  transformIndexHtml: {
    order: "pre",
    handler: () => [
      {
        tag: "meta",
        attrs: {
          name: "platformclaw-web-descriptor",
          content: JSON.stringify(PLATFORMCLAW_WEB_DESCRIPTOR),
        },
        injectTo: "head-prepend",
      },
      {
        tag: "script",
        children: createControlUiMockGatewayInitScript(scenario),
        injectTo: "head-prepend",
      },
      {
        tag: "script",
        children: `const __name = (fn) => fn; (${installBrowserDemo.toString()})(${JSON.stringify(LOCALE_STORAGE_KEY)});`,
        injectTo: "head-prepend",
      },
    ],
  },
};

const config = controlUiViteConfig();
const server = await createServer({
  ...config,
  configFile: false,
  root: path.resolve(import.meta.dirname, "../ui"),
  base: "/",
  plugins: [demoPlugin, ...(config.plugins ?? [])],
  server: { ...config.server, host: "127.0.0.1", port: 60326, strictPort: true, open: false },
});
await server.listen();
console.log(
  "Composer MOCK ready: http://127.0.0.1:60326/platformclaw/app/chat/assigned-personal/main",
);
