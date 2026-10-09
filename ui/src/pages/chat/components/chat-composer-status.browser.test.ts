import type { CDPSession } from "@vitest/browser-playwright";
import { nothing, render } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import "../../../components/tooltip.ts";
import { t } from "../../../i18n/index.ts";
import { buildCompactionDividerItem } from "../chat-progress.ts";
import { buildCachedChatItems, resetChatThreadState } from "../chat-thread.ts";
import { getChatSessionProjection, reduceChatSessionProjection } from "../history-merge.ts";
import { reconcileChatRunLifecycle } from "../run-lifecycle.ts";
import { agentEvent, createHost } from "../tool-stream.test-helpers.ts";
import { handleAgentEvent, type CompactionStatus } from "../tool-stream.ts";
import { renderFallbackIndicator } from "./chat-composer-status.ts";
import { renderChatDivider } from "./chat-divider.ts";
import baseStyles from "../../../styles/base.css?inline";
import composerStatusStyles from "../../../styles/chat/composer-status.css?inline";
import groupedStyles from "../../../styles/chat/grouped.css?inline";
import chatLayoutStyles from "../../../styles/chat/layout.css?inline";
import componentStyles from "../../../styles/components.css?inline";

// The root jsdom shard collects browser tests too; the CDP API must only load
// inside Chromium, where the media emulation and animation assertions run.
const browserMode = "__vitest_browser__" in globalThis;
let cdp: (typeof import("vitest/browser"))["cdp"];

beforeAll(async () => {
  if (browserMode) {
    ({ cdp } = await import("vitest/browser"));
  }
});

describe.runIf(browserMode)("inline compaction motion", () => {
  let container: HTMLDivElement;
  let styles: HTMLStyleElement;
  let session: CDPSession;

  beforeEach(async () => {
    resetChatThreadState();
    session = cdp();
    await session.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
    });
    styles = document.createElement("style");
    styles.textContent = [
      baseStyles,
      componentStyles,
      groupedStyles,
      chatLayoutStyles,
      composerStatusStyles,
    ].join("\n");
    document.head.append(styles);
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(async () => {
    render(nothing, container);
    container.remove();
    styles.remove();
    await session.send("Emulation.setEmulatedMedia", { features: [] });
  });

  it("folds lines inline without a floating scrim, then reveals the completion check", async () => {
    render(renderChatDivider(buildCompactionDividerItem({}, 1_000, 0, "active")), container);
    const indicator = container.querySelector<HTMLElement>(".chat-compaction")!;
    const lines = Array.from(container.querySelectorAll(".chat-compaction__line"));
    const check = container.querySelector<SVGElement>(".chat-compaction__glyph svg")!;
    expect(lines.length).toBeGreaterThan(0);
    expect(getComputedStyle(indicator).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(getComputedStyle(indicator).boxShadow).toBe("none");
    expect(getComputedStyle(indicator).borderTopWidth).toBe("0px");
    expect(getComputedStyle(indicator).animationName).toBe("none");
    expect(getComputedStyle(check).opacity).toBe("0");
    for (const line of lines) {
      expect(getComputedStyle(line).animationName).not.toBe("none");
      expect(getComputedStyle(line).animationIterationCount).toBe("infinite");
    }
    for (const element of container.querySelectorAll("*")) {
      expect(getComputedStyle(element).animationName).not.toContain("spin");
    }

    render(renderChatDivider(buildCompactionDividerItem({}, 1_000, 0, "complete")), container);
    expect(container.querySelector(".chat-compaction")).toBe(indicator);
    expect(container.querySelector(".chat-compaction__glyph svg")).toBe(check);
    for (const line of lines) {
      expect(getComputedStyle(line).visibility).toBe("hidden");
      expect(getComputedStyle(line).animationName).toBe("none");
    }
    await expect.poll(() => getComputedStyle(check).opacity).toBe("1");
    await expect
      .poll(() =>
        indicator
          .getAnimations({ subtree: true })
          .some((animation) => animation.playState === "running"),
      )
      .toBe(false);
  });

  it("keeps compaction outcomes readable without reduced-motion animations", async () => {
    await session.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    expect(matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
    for (const phase of ["active", "complete", "failed", "aborted"] as const) {
      render(renderChatDivider(buildCompactionDividerItem({}, 1_000, 0, phase)), container);
      const indicator = container.querySelector<HTMLElement>(".chat-compaction")!;
      const label = container.querySelector<HTMLElement>(".chat-divider__title")!;
      const check = container.querySelector<SVGElement>(".chat-compaction__glyph svg")!;
      expect(label.textContent?.trim()).not.toBe("");
      expect(getComputedStyle(label).webkitTextFillColor).not.toBe("rgba(0, 0, 0, 0)");
      expect(getComputedStyle(label).backgroundImage).toBe("none");
      await expect.poll(() => getComputedStyle(check).opacity).toBe(phase === "active" ? "0" : "1");
      for (const element of container.querySelectorAll("*")) {
        expect(getComputedStyle(element).animationName).toBe("none");
      }
      await expect
        .poll(() =>
          indicator
            .getAnimations({ subtree: true })
            .some((animation) => animation.playState === "running"),
        )
        .toBe(false);
    }
  });

  it.each(["failed", "aborted"] as const)(
    "keeps the %s event outcome on the same visible row after model-run cleanup",
    async (phase) => {
      const runId = "5d551778-c8b7-4d98-b8dc-82dbcc224842";
      const fixture = createHost({ chatRunId: runId });
      const host = {
        ...fixture,
        compactionStatus: null as CompactionStatus | null,
        sessions: { ...fixture.sessions, reconcileRunTerminal: () => false },
      };
      const input = {
        paneId: "browser-failure-pane",
        sessionKey: "main",
        messages: [],
        toolMessages: [],
        streamSegments: [],
        stream: null,
        streamStartedAt: null,
        showToolCalls: true,
      };
      const paint = () =>
        render(
          repeat(
            buildCachedChatItems({
              ...input,
              compactionStatus: host.compactionStatus,
            }),
            (item) => item.key,
            (item) => (item.kind === "divider" ? renderChatDivider(item) : nothing),
          ),
          container,
        );
      handleAgentEvent(
        host,
        agentEvent(runId, 1, "compaction", { phase: "start", itemId: "compact-1" }),
      );
      paint();
      const row = container.querySelector<HTMLElement>(".chat-compaction")!;
      handleAgentEvent(
        host,
        agentEvent(runId, 2, "compaction", {
          phase: "end",
          itemId: "compact-1",
          completed: false,
          failed: phase === "failed",
          aborted: phase === "aborted",
          reason: "Summarization could not complete. <script>privatePayload()</script>",
        }),
      );
      paint();
      reconcileChatRunLifecycle(host, { outcome: "interrupted", runId, clearLocalRun: true });
      paint();
      expect(container.querySelector(".chat-compaction")).toBe(row);
      expect(row.classList.contains(`chat-compaction--${phase}`)).toBe(true);
      expect(row.textContent).toContain(t(`chat.compaction.${phase}`));
      expect(row.textContent).toContain("Summarization could not complete.");
      expect(row.textContent).toContain(t("gatewayErrors.runId", { id: runId }));
      expect(row.textContent).toContain(t("chat.compaction.checkBeforeRetry"));
      expect(row.querySelector('[role="status"]')?.getAttribute("aria-label")).toContain(
        "Summarization could not complete.",
      );
      expect(row.querySelector("script")).toBeNull();
      expect(row.querySelector(".chat-divider__metric")).toBeNull();
      expect(row.querySelector(".chat-divider__action")).toBeNull();
      const glyph = row.querySelector<SVGElement>(".chat-compaction__glyph svg")!;
      await expect.poll(() => getComputedStyle(glyph).opacity).toBe("1");
      for (const line of row.querySelectorAll(".chat-compaction__line")) {
        expect(getComputedStyle(line).visibility).toBe("hidden");
        expect(getComputedStyle(line).animationName).toBe("none");
      }
      await expect
        .poll(() =>
          row
            .getAnimations({ subtree: true })
            .some((animation) => animation.playState === "running"),
        )
        .toBe(false);
    },
  );

  it("retains the keyed DOM row when matching compaction history rotates session and leaf", () => {
    const status = {
      phase: "active" as const,
      runId: "run-1",
      itemId: "compact-1",
      startedAt: 1_000,
      completedAt: null,
    };
    const input = {
      paneId: "browser-pane",
      sessionKey: "main",
      messages: [] as unknown[],
      toolMessages: [],
      streamSegments: [],
      stream: null,
      streamStartedAt: null,
      showToolCalls: true,
      compactionStatus: status,
    };
    const owner = {
      sessionKey: input.sessionKey,
      chatMessages: [] as unknown[],
      compactionStatus: status as CompactionStatus | null,
    };
    const scope = {
      sessionKey: input.sessionKey,
      sessionId: "session-before-compaction",
      agentId: "main",
      lifecycleRevision: 1,
      activeLeafEntryId: "leaf-before-compaction",
    };
    getChatSessionProjection(owner, [], scope);
    const paint = (props: Parameters<typeof buildCachedChatItems>[0]) =>
      render(
        repeat(
          buildCachedChatItems(props),
          (item) => item.key,
          (item) => (item.kind === "divider" ? renderChatDivider(item) : nothing),
        ),
        container,
      );
    paint(input);
    const row = container.querySelector(".chat-compaction")!;
    const glyph = row.querySelector(".chat-compaction__glyph")!;
    expect(row.querySelector('[role="status"]')?.getAttribute("aria-live")).toBe("polite");
    owner.compactionStatus = { ...status, phase: "complete", completedAt: 2_000 };
    paint({ ...input, compactionStatus: owner.compactionStatus });
    const messages = [
      {
        role: "system",
        timestamp: 2_000,
        __openclaw: {
          kind: "compaction",
          id: "entry-1",
          runId: "run-1",
          itemId: "compact-1",
          tokensBefore: 20_000,
          tokensAfter: 5_000,
        },
      },
    ];
    reduceChatSessionProjection(
      owner,
      { type: "snapshotLoaded", messages },
      {
        scope: {
          ...scope,
          sessionId: "session-after-compaction",
          activeLeafEntryId: "entry-1",
        },
        messages: [],
      },
    );
    expect(owner.compactionStatus).toMatchObject({
      phase: "complete",
      runId: "run-1",
      itemId: "compact-1",
    });
    paint({ ...input, messages: owner.chatMessages, compactionStatus: owner.compactionStatus });
    expect(container.querySelector(".chat-compaction")).toBe(row);
    paint({ ...input, messages: owner.chatMessages, compactionStatus: null });
    expect(container.querySelectorAll(".chat-compaction")).toHaveLength(1);
    expect(container.querySelector(".chat-compaction")).toBe(row);
    expect(row.querySelector(".chat-compaction__glyph")).toBe(glyph);
    expect(row.classList.contains("chat-compaction--complete")).toBe(true);
    expect(row.textContent).toContain(t("chat.composer.contextCompacted"));
    expect(row.textContent).toContain(t("chat.compaction.savedTokens", { count: "15k" }));
    expect(row.querySelector(".chat-divider__description")).toBeNull();
    expect(container.querySelector(".compaction-indicator--active")).toBeNull();
  });

  it("keeps the label readable in forced-colors mode", async () => {
    await session.send("Emulation.setEmulatedMedia", {
      features: [
        { name: "prefers-reduced-motion", value: "no-preference" },
        { name: "forced-colors", value: "active" },
      ],
    });
    expect(matchMedia("(forced-colors: active)").matches).toBe(true);
    for (const phase of ["active", "complete", "failed", "aborted"] as const) {
      render(renderChatDivider(buildCompactionDividerItem({}, 1_000, 0, phase)), container);
      const label = container.querySelector<HTMLElement>(".chat-divider__title")!;
      expect(label.textContent?.trim()).not.toBe("");
      expect(getComputedStyle(label).webkitTextFillColor).not.toBe("rgba(0, 0, 0, 0)");
      expect(getComputedStyle(label).backgroundImage).toBe("none");
      expect(getComputedStyle(label).animationName).toBe("none");
    }
  });

  it.each(["active", "cleared"] as const)("preserves the %s fallback pill", async (phase) => {
    render(
      renderFallbackIndicator({
        phase,
        selected: "provider/selected",
        active: "provider/active",
        attempts: [],
        occurredAt: Date.now(),
      }),
      container,
    );
    await container.querySelector("openclaw-tooltip")!.updateComplete;
    const indicator = container.querySelector<HTMLElement>(".compaction-indicator")!;
    const icon = indicator.querySelector("svg")!;
    expect(getComputedStyle(indicator).borderTopWidth).toBe("1px");
    expect(getComputedStyle(indicator).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(getComputedStyle(icon).width).toBe("16px");
    expect(indicator.querySelector(".compaction-indicator__glyph")).toBeNull();
    expect(indicator.getAttribute("role")).toBe("status");
  });
});
