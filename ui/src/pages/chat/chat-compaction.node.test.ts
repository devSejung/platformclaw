// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "../../i18n/index.ts";
import type { ChatItem } from "../../lib/chat/chat-types.ts";
import { buildCachedChatItems, resetChatThreadState } from "./chat-thread.ts";
import {
  agentEvent,
  createHost,
  TOOL_STREAM_TEST_NOW,
  useToolStreamFakeTimers,
} from "./tool-stream.test-helpers.ts";
import {
  handleAgentEvent,
  handleSessionOperationEvent,
  type CompactionStatus,
} from "./tool-stream.ts";

type Props = Parameters<typeof buildCachedChatItems>[0];
type Divider = Extract<ChatItem, { kind: "divider" }>;
const active: CompactionStatus = {
  phase: "active",
  runId: "run-1",
  itemId: "compact-1",
  startedAt: 1_000,
  completedAt: null,
};

function props(overrides: Partial<Props> = {}): Props {
  return {
    paneId: "compaction-pane",
    sessionKey: "main",
    messages: [],
    toolMessages: [],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    showToolCalls: true,
    ...overrides,
  };
}

function persisted(itemId = "compact-1") {
  return {
    role: "system",
    timestamp: 2_000,
    __openclaw: {
      kind: "compaction",
      id: `entry-${itemId}`,
      runId: "run-1",
      itemId,
      tokensBefore: 20_000,
      tokensAfter: 5_000,
    },
  };
}

function dividers(input: Props): Divider[] {
  return buildCachedChatItems(input).filter((item): item is Divider => item.kind === "divider");
}

describe("one compaction transcript row", () => {
  beforeEach(() => resetChatThreadState());

  it("adopts persisted history through retry and completion without changing the live row key", () => {
    const input = props({ compactionStatus: active, runWorking: true });
    const started = dividers(input)[0]!;
    expect(started).toMatchObject({
      compaction: "active",
      label: t("chat.composer.compactingContext"),
    });
    expect(buildCachedChatItems(input).some((item) => item.kind === "reading-indicator")).toBe(
      false,
    );
    const retry = dividers({ ...input, compactionStatus: { ...active, phase: "retrying" } });
    expect(retry).toHaveLength(1);
    expect(retry[0]?.key).toBe(started.key);
    const complete = dividers({
      ...input,
      compactionStatus: { ...active, phase: "complete", completedAt: 2_000 },
    });
    expect(complete[0]).toMatchObject({ key: started.key, compaction: "complete" });
    const history = [persisted()];
    const adopted = dividers({ ...input, messages: history });
    expect(adopted).toHaveLength(1);
    expect(adopted[0]).toMatchObject({
      key: started.key,
      compaction: "complete",
      metric: t("chat.compaction.savedTokens", { count: "15k" }),
      action: { kind: "session-checkpoints" },
    });
    const refreshed = dividers({ ...input, messages: history, compactionStatus: null });
    expect(refreshed).toHaveLength(1);
    expect(refreshed[0]).toBe(adopted[0]);
    expect(refreshed[0]?.description).toBeUndefined();
    expect(
      buildCachedChatItems({
        ...input,
        messages: history,
        compactionStatus: { ...active, phase: "retrying" },
      }).some((item) => item.kind === "reading-indicator"),
    ).toBe(true);
  });

  it("keeps separate compactions in the same run distinct", () => {
    const first = dividers(props({ compactionStatus: active }))[0]!;
    dividers(props({ messages: [persisted()], compactionStatus: active }));
    const repeated = dividers(
      props({
        messages: [persisted()],
        compactionStatus: { ...active, itemId: "compact-2", startedAt: 3_000 },
      }),
    );
    expect(repeated).toHaveLength(2);
    expect(repeated[0]).toMatchObject({ key: first.key, compaction: "complete" });
    expect(repeated[1]).toMatchObject({ compaction: "active" });
    expect(repeated[1]?.key).not.toBe(first.key);
  });

  it("renders native runtime compaction as a divider and correlates manual operation identity", () => {
    const native = {
      role: "custom",
      customType: "openclaw.context-compaction",
      timestamp: 2_000,
      content: "Context compacted",
      __openclaw: { id: "native-entry", runId: "run-1", itemId: "compact-1" },
    };
    const items = buildCachedChatItems(props({ messages: [native], compactionStatus: active }));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "divider", compaction: "complete" });
    expect(
      dividers(
        props({ messages: [persisted()], compactionStatus: { ...active, itemId: undefined } }),
      ),
    ).toHaveLength(1);
  });

  it("never adopts an unrelated or uncorrelated history marker", () => {
    const unrelated = persisted();
    unrelated["__openclaw"].runId = "older-run";
    expect(dividers(props({ messages: [unrelated], compactionStatus: active }))).toHaveLength(2);
    const uncorrelated = { ...persisted(), __openclaw: { kind: "compaction", id: "old-entry" } };
    expect(dividers(props({ messages: [uncorrelated], compactionStatus: active }))).toHaveLength(2);
  });

  it("isolates cached compaction identity between split panes", () => {
    const live = dividers(props({ compactionStatus: active }))[0]!;
    const other = dividers(props({ paneId: "other-pane", messages: [persisted()] }))[0]!;
    expect(other.key).not.toBe(live.key);
    expect(dividers(props({ messages: [persisted()], compactionStatus: active }))[0]?.key).toBe(
      live.key,
    );
  });

  it.each(["failed", "aborted"] as const)(
    "keeps a %s result on the live row without a success metric or checkpoint action",
    (phase) => {
      const runId = "5d551778-c8b7-4d98-b8dc-82dbcc224842";
      const input = props({ compactionStatus: { ...active, runId }, runWorking: true });
      const started = dividers(input)[0]!;
      const result = {
        ...active,
        runId,
        phase,
        reason: "Summarization could not complete.",
        completedAt: 2_000,
      };
      const settled = dividers({ ...input, compactionStatus: result });
      expect(settled).toHaveLength(1);
      expect(settled[0]).toMatchObject({
        key: started.key,
        compaction: phase,
        label: t(`chat.compaction.${phase}`),
        description: [
          result.reason,
          t("gatewayErrors.runId", { id: runId }),
          t("chat.compaction.checkBeforeRetry"),
        ].join("\n\n"),
      });
      expect(settled[0]?.metric).toBeUndefined();
      expect(settled[0]?.action).toBeUndefined();
      expect(
        buildCachedChatItems({ ...input, compactionStatus: result }).some(
          (item) => item.kind === "reading-indicator",
        ),
      ).toBe(true);
    },
  );
});

describe("compaction sequence fencing", () => {
  beforeEach(() => {
    Object.assign(globalThis, { window: globalThis });
    useToolStreamFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("rejects stale starts, duplicate completions and prior item replay", () => {
    const host = createHost();
    const event = (seq: number, phase: string, itemId = "compact-1") =>
      handleAgentEvent(
        host,
        agentEvent("run-1", seq, "compaction", { phase, itemId, completed: true }),
      );
    event(2, "start");
    vi.advanceTimersByTime(100);
    event(3, "end");
    const completed = host.compactionStatus;
    event(1, "start");
    event(3, "end");
    expect(host.compactionStatus).toBe(completed);
    event(5, "start", "compact-2");
    event(4, "end");
    expect(host.compactionStatus).toMatchObject({
      phase: "active",
      itemId: "compact-2",
      startedAt: TOOL_STREAM_TEST_NOW + 100,
    });
    vi.advanceTimersByTime(5 * 60_000);
    expect(host.compactionStatus).toBeNull();
  });

  it("keeps retry completion durable and fences late retry snapshots after terminal lifecycle", () => {
    const host = createHost();
    handleAgentEvent(
      host,
      agentEvent("run-1", 1, "compaction", { phase: "start", itemId: "compact-1" }),
    );
    handleAgentEvent(
      host,
      agentEvent("run-1", 2, "compaction", {
        phase: "end",
        itemId: "compact-1",
        completed: true,
        willRetry: true,
      }),
    );
    handleAgentEvent(host, agentEvent("run-1", 4, "lifecycle", { phase: "end" }));
    const completed = host.compactionStatus;
    handleAgentEvent(
      host,
      agentEvent("run-1", 3, "compaction", {
        phase: "end",
        itemId: "compact-1",
        completed: true,
        willRetry: true,
      }),
    );
    vi.advanceTimersByTime(5 * 60_000);
    expect(host.compactionStatus).toBe(completed);
    expect(completed).toMatchObject({ phase: "complete", itemId: "compact-1" });
    expect(host.compactionClearTimer).toBeNull();
  });

  it.each([
    { failed: true, aborted: false, phase: "failed" },
    { failed: false, aborted: true, phase: "aborted" },
    { failed: true, aborted: true, phase: "failed" },
  ] as const)(
    "records $phase terminal facts without a stale timer",
    ({ failed, aborted, phase }) => {
      const host = createHost({ chatRunId: "run-1" });
      handleAgentEvent(
        host,
        agentEvent("run-1", 1, "compaction", { phase: "start", itemId: "compact-1" }),
      );
      handleAgentEvent(
        host,
        agentEvent("run-1", 2, "compaction", {
          phase: "end",
          itemId: "compact-1",
          completed: false,
          failed,
          aborted,
          reason: "Summarization could not complete.",
        }),
      );
      const terminal = host.compactionStatus;
      expect(terminal).toMatchObject({
        phase,
        itemId: "compact-1",
        completedAt: TOOL_STREAM_TEST_NOW,
      });
      handleAgentEvent(host, agentEvent("run-1", 3, "lifecycle", { phase: "end" }));
      vi.advanceTimersByTime(5 * 60_000);
      expect(host.compactionStatus).toBe(terminal);
      expect(host.compactionClearTimer).toBeNull();
    },
  );

  it("requires an explicit failure fact instead of inferring failure from a no-op reason", () => {
    const host = createHost();
    handleAgentEvent(host, agentEvent("run-1", 1, "compaction", { phase: "start" }));
    handleAgentEvent(
      host,
      agentEvent("run-1", 2, "compaction", {
        phase: "end",
        completed: false,
        failed: false,
        reason: "There is nothing to compact.",
      }),
    );
    expect(host.compactionStatus).toBeNull();
    handleAgentEvent(
      host,
      agentEvent("run-1", 3, "compaction", {
        phase: "end",
        completed: false,
        reason: "Summarization failed.",
      }),
    );
    expect(host.compactionStatus).toBeNull();
  });

  it("preserves a reasonful manual skip and records a subsequent explicit failure with its operation ID", () => {
    const host = createHost();
    const operationId = "5d551778-c8b7-4d98-b8dc-82dbcc224842";
    const event = { operationId, operation: "compact", sessionKey: "main" };
    handleSessionOperationEvent(host, { ...event, phase: "start" });
    handleSessionOperationEvent(host, {
      ...event,
      phase: "end",
      completed: false,
      failed: false,
      reason: "There is nothing to compact.",
    });
    expect(host.compactionStatus).toBeNull();
    handleSessionOperationEvent(host, { ...event, phase: "start" });
    handleSessionOperationEvent(host, {
      ...event,
      phase: "end",
      completed: false,
      failed: true,
      reason: "Summarization failed.",
    });
    const terminal = host.compactionStatus as CompactionStatus;
    expect(terminal).toMatchObject({
      phase: "failed",
      operationId,
      runId: operationId,
      reason: "Summarization failed.",
    });
    expect(dividers(props({ compactionStatus: terminal }))[0]?.description).toContain(
      t("gatewayErrors.operationId", { id: operationId }),
    );
    expect(host.compactionClearTimer).toBeNull();
  });
});
