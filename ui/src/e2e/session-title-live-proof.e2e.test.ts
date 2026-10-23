import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { SessionEntry } from "../../../src/config/sessions.js";
import {
  appendTranscriptMessageSync,
  replaceSessionEntry,
} from "../../../src/config/sessions/session-accessor.js";
import { approveDevicePairing, listDevicePairing } from "../../../src/infra/device-pairing.js";
import { createOpenClawTestInstance } from "../../../test/helpers/openclaw-test-instance.js";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { requireRecord } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { captureUiProof, uiProofArtifactDir } from "./session-management.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI session titles through a real Gateway",
  trackBrowserContexts: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is unavailable at ${executablePath}.`,
});

type TitleFixture = { key: string; text: string; label?: string; displayName?: string };

async function browserRpc(
  page: Page,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return page.locator("openclaw-chat-pane").evaluate(
    async (element, request) => {
      const pane = element as HTMLElement & {
        state?: {
          client?: {
            request: (
              method: string,
              params: Record<string, unknown>,
            ) => Promise<Record<string, unknown>>;
          };
        };
      };
      if (!pane.state?.client) {
        throw new Error("Expected a connected real Gateway client");
      }
      return pane.state.client.request(request.method, request.params);
    },
    { method, params },
  );
}

async function waitForSelectedHistory(page: Page, key: string): Promise<void> {
  await expect
    .poll(() =>
      page.locator("openclaw-chat-pane").evaluate((element, expectedKey) => {
        const pane = element as HTMLElement & {
          state?: { sessionKey: string; currentSessionId?: string; chatLoading: boolean };
        };
        return (
          pane.state?.sessionKey === expectedKey &&
          Boolean(pane.state.currentSessionId) &&
          !pane.state.chatLoading
        );
      }, key),
    )
    .toBe(true);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      }),
  );
}

suite.define(() => {
  it("compares persisted names, empty/reset projections, and derived titles during real navigation", async () => {
    const instance = await createOpenClawTestInstance({
      name: "session-title-live-proof",
      gatewayToken: "isolated-title-proof-token",
      env: {
        OPENCLAW_GATEWAY_PASSWORD: undefined,
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        // Exercise the packaged production metadata lifecycle. Minimal test
        // gateways defer model catalog preparation until the first browser read.
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        VITEST: undefined,
      },
    });
    const state = instance.state;
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const observations: Array<Record<string, unknown>> = [];
    const responses: Array<Record<string, unknown>> = [];
    let gatewayEntrypoint: string[] = [];

    try {
      const port = instance.port;
      const gatewayUrl = instance.url;
      const token = instance.gatewayToken;
      await state.writeConfig({
        agents: {
          defaults: { model: { primary: "openai/gpt-5.6-luna" }, workspace: state.workspaceDir },
          entries: { main: { default: true } },
        },
        gateway: {
          port,
          bind: "loopback",
          auth: { mode: "token", token },
          controlUi: { enabled: false, allowedOrigins: [new URL(suite.server.baseUrl).origin] },
        },
      });
      state.applyEnv();
      const fixtures: [
        TitleFixture,
        TitleFixture,
        TitleFixture,
        TitleFixture,
        TitleFixture,
        TitleFixture,
      ] = [
        {
          key: "agent:main:dashboard:starting",
          text: "Named starting thread",
          label: "Named starting thread",
        },
        {
          key: "agent:main:dashboard:persisted",
          text: "Generated title source",
          displayName: "Persisted generated title",
        },
        {
          key: "agent:main:dashboard:labelled",
          text: "Explicit label source",
          label: "Explicit thread label",
        },
        { key: "agent:main:dashboard:reset", text: "Discussion retained across reset" },
        { key: "agent:main:dashboard:planning", text: "Plan the quarterly release" },
        { key: "agent:main:dashboard:investigation", text: "Investigate the deployment failure" },
      ];
      const storePath = path.join(state.sessionsDir(), "sessions.json");
      for (const [index, fixture] of fixtures.entries()) {
        const entry: SessionEntry = {
          sessionId: `live-title-proof-${index}`,
          updatedAt: Date.now() - index,
          ...(fixture.label ? { label: fixture.label } : {}),
          ...(fixture.displayName ? { displayName: fixture.displayName } : {}),
        };
        const scope = { agentId: "main", sessionKey: fixture.key, storePath };
        await replaceSessionEntry(scope, entry);
        appendTranscriptMessageSync(
          { ...scope, sessionId: entry.sessionId },
          {
            message: { role: "user", content: fixture.text, timestamp: Date.now() },
          },
        );
      }
      // The packaged child uses built runtime handlers. Importing the source
      // Gateway inside Vitest would make browser latency include test transforms.
      gatewayEntrypoint = await instance.entrypoint();
      expect(gatewayEntrypoint[0]).toMatch(/^dist\/index\.m?js$/);
      await instance.startGateway();

      const page = await context.newPage();
      const trackedMethods = new Set([
        "chat.startup",
        "chat.history",
        "sessions.list",
        "sessions.patch",
        "sessions.reset",
        "sessions.create",
      ]);
      page.on("websocket", (socket) => {
        const requests = new Map<string, { method: string; params: unknown }>();
        socket.on("framesent", ({ payload }) => {
          const frame = requireRecord(JSON.parse(String(payload)));
          if (
            frame.type === "req" &&
            typeof frame.method === "string" &&
            trackedMethods.has(frame.method)
          ) {
            requests.set(String(frame.id), { method: frame.method, params: frame.params });
          }
        });
        socket.on("framereceived", ({ payload }) => {
          const frame = requireRecord(JSON.parse(String(payload)));
          const request = requests.get(String(frame.id));
          if (frame.type === "res" && request) {
            responses.push({
              ...request,
              ok: frame.ok,
              payload: frame.payload,
              error: frame.error,
            });
            requests.delete(String(frame.id));
          }
        });
      });
      await page.addInitScript(
        (nativeAuth) => {
          (
            window as Window & {
              ["__OPENCLAW_NATIVE_CONTROL_AUTH__"]?: { gatewayUrl: string; token: string };
            }
          )["__OPENCLAW_NATIVE_CONTROL_AUTH__"] = nativeAuth;
        },
        { gatewayUrl, token },
      );
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, fixtures[0].key));
      // Approve only this isolated browser's actual device request. Authentication,
      // pairing, WebSocket dispatch, and session RPCs all remain production code.
      await expect
        .poll(
          async () => {
            const pairings = await listDevicePairing();
            for (const pending of pairings.pending) {
              await approveDevicePairing(pending.requestId, {
                callerScopes: ["operator.admin", "operator.pairing"],
              });
            }
            return page.locator("openclaw-chat-pane").evaluateAll((elements) =>
              elements.some((element) => {
                const pane = element as HTMLElement & {
                  state?: { connected: boolean; currentSessionId?: string };
                };
                return pane.state?.connected && Boolean(pane.state.currentSessionId);
              }),
            );
          },
          { timeout: 60_000 },
        )
        .toBe(true);
      await waitForSelectedHistory(page, fixtures[0].key);
      expect(await page.evaluate(() => WebSocket.toString())).toContain("[native code]");

      const observe = async (stage: string, key: string) => {
        const list = await browserRpc(page, "sessions.list", {
          agentId: "main",
          includeDerivedTitles: true,
          includeGlobal: true,
          includeUnknown: true,
        });
        const history = await browserRpc(page, "chat.history", {
          sessionKey: key,
          agentId: "main",
          limit: 10,
        });
        const row = page.locator(`.sidebar-recent-session[data-session-key="${key}"]`);
        observations.push({
          stage,
          key,
          header: await page.locator(".chat-pane__session-title").textContent(),
          sidebar: await row.locator(".sidebar-recent-session__name").textContent(),
          listRow: Array.isArray(list.sessions)
            ? list.sessions.find((candidate) => requireRecord(candidate).key === key)
            : null,
          historyRow: history.sessionInfo,
          messageCount: Array.isArray(history.messages) ? history.messages.length : null,
        });
        await captureUiProof(page, `live-title-${stage}.png`);
      };
      const select = async (key: string) => {
        const responseStart = responses.length;
        await page
          .locator(
            `.sidebar-recent-session[data-session-key="${key}"] a.sidebar-recent-session__link`,
          )
          .click();
        await expect
          .poll(() =>
            responses
              .slice(responseStart)
              .some(
                (response) =>
                  (response.method === "chat.startup" || response.method === "chat.history") &&
                  response.ok === true &&
                  requireRecord(response.params).sessionKey === key,
              ),
          )
          .toBe(true);
        await waitForSelectedHistory(page, key);
      };
      const expectTitle = async (key: string, title: string) => {
        expect(
          await page
            .locator(
              `.sidebar-recent-session[data-session-key="${key}"] .sidebar-recent-session__name`,
            )
            .textContent(),
        ).toBe(title);
        expect(await page.locator(".chat-pane__session-title").textContent()).toContain(title);
      };

      // Negative controls run first: completed generation is durable displayName,
      // while a human rename is label. Neither depends on transcript title probing.
      for (const fixture of [fixtures[1], fixtures[2], fixtures[1]]) {
        await select(fixture.key);
        await observe(`control-${observations.length}`, fixture.key);
        await expectTitle(fixture.key, fixture.label ?? fixture.displayName ?? fixture.text);
      }
      await page.locator(".chat-pane__session-title-button").click();
      const renameInput = page.locator(".chat-pane__session-title-input");
      await renameInput.fill("Human renamed generated thread");
      await renameInput.press("Enter");
      await expect
        .poll(() => page.locator(".chat-pane__session-title").textContent())
        .toContain("Human renamed generated thread");
      await select(fixtures[2].key);
      await select(fixtures[1].key);
      await observe("after-human-rename", fixtures[1].key);
      await expectTitle(fixtures[1].key, "Human renamed generated thread");

      await select(fixtures[3].key);
      await observe("before-reset", fixtures[3].key);
      await browserRpc(page, "sessions.reset", { key: fixtures[3].key, agentId: "main" });
      await select(fixtures[2].key);
      await select(fixtures[3].key);
      await observe("after-reset", fixtures[3].key);
      const afterReset = observations.at(-1);
      // Reset retains a recent user/assistant replay tail; this single user
      // message remains visible by the canonical reset-boundary contract.
      expect(afterReset?.messageCount).toBe(1);

      const created = await browserRpc(page, "sessions.create", { agentId: "main" });
      if (typeof created.key !== "string") {
        throw new Error("sessions.create did not return a session key");
      }
      await select(created.key);
      await observe("empty-created", created.key);
      expect(observations.at(-1)?.messageCount).toBe(0);
      expect(requireRecord(observations.at(-1)?.historyRow).derivedTitle).toBeUndefined();
      // Lists already expose an id fallback for persisted empty sessions.
      // History must not add that fallback as a new content-derived title.
      await select(fixtures[0].key);
      await page.evaluate(
        (keys) => {
          const proof = window as Window & { liveTitleFallbacks?: string[] };
          proof.liveTitleFallbacks = [];
          const selectors = [
            ".chat-pane__session-title",
            ...keys.map(
              (key) =>
                `.sidebar-recent-session[data-session-key="${key}"] .sidebar-recent-session__name`,
            ),
          ].join(", ");
          const recordFallback = (element: Element, text: string | null) => {
            if (text?.trim() === "New thread") {
              proof.liveTitleFallbacks?.push(
                element.closest("[data-session-key]")?.getAttribute("data-session-key") ?? "header",
              );
            }
          };
          // Keep transient fallback evidence even when a later list refresh makes
          // the eventual title correct before the host-side assertion runs.
          const observer = new MutationObserver((mutations) => {
            for (const element of document.querySelectorAll(selectors)) {
              recordFallback(element, element.textContent);
            }
            for (const mutation of mutations) {
              const parent =
                mutation.target instanceof Element
                  ? mutation.target
                  : mutation.target.parentElement;
              const title = parent?.closest(selectors);
              if (!title) {
                continue;
              }
              if (mutation.type === "characterData") {
                recordFallback(title, mutation.oldValue);
              }
              for (const removed of mutation.removedNodes) {
                recordFallback(title, removed.textContent);
              }
            }
          });
          observer.observe(document.body, {
            subtree: true,
            childList: true,
            characterData: true,
            characterDataOldValue: true,
          });
        },
        [fixtures[4].key, fixtures[5].key],
      );

      for (const [index, fixture] of [
        fixtures[4],
        fixtures[5],
        fixtures[4],
        fixtures[5],
      ].entries()) {
        await select(fixture.key);
        await observe(`derived-${index}`, fixture.key);
        await expectTitle(fixture.key, fixture.text);
        expect(
          await page.evaluate(
            () => (window as Window & { liveTitleFallbacks?: string[] }).liveTitleFallbacks,
          ),
        ).toEqual([]);
      }
      expect(responses.some((response) => response.method === "chat.startup")).toBe(true);
      expect(responses.some((response) => response.method === "chat.history")).toBe(true);
    } finally {
      try {
        await mkdir(uiProofArtifactDir, { recursive: true });
        await writeFile(
          path.join(uiProofArtifactDir, "live-title-observations.json"),
          `${JSON.stringify({ gatewayEntrypoint, observations, responses }, null, 2)}\n`,
          "utf8",
        );
        await writeFile(
          path.join(uiProofArtifactDir, "live-title-gateway.log"),
          instance.logs(),
          "utf8",
        );
      } finally {
        try {
          await suite.closeBrowserContext(context);
        } finally {
          await instance.cleanup();
        }
      }
    }
  }, 120_000);
});
