// Matrix tests cover subagent hooks plugin behavior.
import type { OpenClawPluginApi as MatrixEntryPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";
import {
  getRequiredHookHandler,
  registerHookHandlersForTest,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerMatrixSubagentHooks } from "../../subagent-hooks-api.js";

// Hoisted stubs referenced in vi.mock factories below
const unbindMock = vi.hoisted(() => vi.fn());
const getManagerMock = vi.hoisted(() => vi.fn());
const listAllBindingsMock = vi.hoisted(() => vi.fn((): any[] => []));
const listBindingsForAccountMock = vi.hoisted(() => vi.fn((): any[] => []));
const removeBindingRecordMock = vi.hoisted(() => vi.fn(() => false));

vi.mock("openclaw/plugin-sdk/conversation-binding-runtime", () => ({
  getSessionBindingService: () => ({
    unbind: unbindMock,
  }),
}));

vi.mock("./thread-bindings-shared.js", () => ({
  getMatrixThreadBindingManager: getManagerMock,
  listAllBindings: listAllBindingsMock,
  listBindingsForAccount: listBindingsForAccountMock,
  removeBindingRecord: removeBindingRecordMock,
  resolveBindingKey: (params: {
    accountId: string;
    conversationId: string;
    parentConversationId?: string;
  }) =>
    `${params.accountId}:${params.parentConversationId?.trim() || "-"}:${params.conversationId}`,
}));

import { handleMatrixSubagentDeliveryTarget, handleMatrixSubagentEnded } from "./subagent-hooks.js";

const DEFAULT_CHILD_SESSION_KEY = "agent:ops:subagent:child";
const DEFAULT_ROOM_ID = "!room:example";

function registerHandlersForTest(config: Record<string, unknown> = {}) {
  return registerHookHandlersForTest<MatrixEntryPluginApi>({
    config,
    register: registerMatrixSubagentHooks,
  });
}

function makeBinding(
  overrides: Partial<{
    targetSessionKey: string;
    targetKind: string;
    accountId: string;
    conversationId: string;
    parentConversationId: string | undefined;
  }> = {},
) {
  return {
    targetSessionKey: DEFAULT_CHILD_SESSION_KEY,
    targetKind: "subagent",
    accountId: "ops",
    conversationId: "$thread",
    parentConversationId: DEFAULT_ROOM_ID,
    boundAt: 0,
    lastActivityAt: 0,
    ...overrides,
  };
}

function makeDeliveryEvent(
  overrides: Partial<{
    childSessionKey: string;
    channel: string;
    accountId: string | undefined;
    to: string;
    threadId: string;
    expectsCompletionMessage: boolean;
  }> = {},
) {
  const requesterOrigin: {
    channel: string;
    accountId?: string;
    to?: string;
    threadId?: string;
  } = { channel: overrides.channel ?? "matrix" };
  if (!("accountId" in overrides) || overrides.accountId !== undefined) {
    requesterOrigin.accountId = overrides.accountId ?? "ops";
  }
  if (overrides.to !== undefined) {
    requesterOrigin.to = overrides.to;
  }
  if (overrides.threadId !== undefined) {
    requesterOrigin.threadId = overrides.threadId;
  }
  return {
    childSessionKey: overrides.childSessionKey ?? DEFAULT_CHILD_SESSION_KEY,
    requesterOrigin,
    expectsCompletionMessage: overrides.expectsCompletionMessage ?? true,
  };
}

function makeDeliveryResult(
  overrides: Partial<{ accountId: string; to: string; threadId: string }> = {},
) {
  return {
    origin: {
      channel: "matrix",
      accountId: "ops",
      to: `room:${DEFAULT_ROOM_ID}`,
      ...overrides,
    },
  };
}

describe("matrix subagent hook registration", () => {
  beforeEach(() => {
    listBindingsForAccountMock.mockReset();
    listAllBindingsMock.mockReset();
  });

  it("resolves delivery targets through the lazy registration barrel", async () => {
    listBindingsForAccountMock.mockReturnValue([
      makeBinding({
        conversationId: "$thread-ops",
        parentConversationId: "!roomAbc:technerik.com",
        targetSessionKey: "agent:ops:subagent:worker",
      }),
    ]);
    const handlers = registerHandlersForTest();
    const handler = getRequiredHookHandler(handlers, "subagent_delivery_target");

    await expect(
      handler(
        makeDeliveryEvent({
          childSessionKey: "agent:ops:subagent:worker",
          to: "room:!roomAbc:technerik.com",
          threadId: "$thread-ops",
        }),
        {},
      ),
    ).resolves.toEqual(
      makeDeliveryResult({ to: "room:!roomAbc:technerik.com", threadId: "$thread-ops" }),
    );
  });
});

describe("handleMatrixSubagentEnded", () => {
  const mockManager = { persist: vi.fn() };

  beforeEach(() => {
    getManagerMock.mockReset();
    listAllBindingsMock.mockReset();
    listBindingsForAccountMock.mockReset();
    removeBindingRecordMock.mockReset();
    unbindMock.mockReset();
    mockManager.persist.mockReset();
  });

  it("does nothing when no matching bindings exist", async () => {
    listBindingsForAccountMock.mockReturnValue([]);
    await handleMatrixSubagentEnded({
      targetSessionKey: "agent:ops:subagent:child",
      targetKind: "subagent",
      accountId: "ops",
    });
    expect(getManagerMock).not.toHaveBeenCalled();
  });

  it("removes matching bindings and calls persist on the manager", async () => {
    const binding = makeBinding();
    listBindingsForAccountMock.mockReturnValue([binding]);
    removeBindingRecordMock.mockReturnValue(true);
    getManagerMock.mockReturnValue(mockManager);
    mockManager.persist.mockResolvedValue(undefined);

    await handleMatrixSubagentEnded({
      targetSessionKey: "agent:ops:subagent:child",
      targetKind: "subagent",
      accountId: "ops",
    });

    expect(removeBindingRecordMock).toHaveBeenCalledWith(binding);
    expect(getManagerMock).toHaveBeenCalledWith("ops");
    expect(mockManager.persist).toHaveBeenCalled();
  });

  it("sends farewell through the binding service when requested", async () => {
    const binding = makeBinding();
    listBindingsForAccountMock.mockReturnValue([binding]);
    unbindMock.mockResolvedValue([
      {
        bindingId: "ops:!room:example:$thread",
        targetSessionKey: "agent:ops:subagent:child",
        targetKind: "subagent",
        conversation: {
          channel: "matrix",
          accountId: "ops",
          conversationId: "$thread",
          parentConversationId: "!room:example",
        },
        status: "active",
        boundAt: 0,
      },
    ]);

    await handleMatrixSubagentEnded({
      targetSessionKey: "agent:ops:subagent:child",
      targetKind: "subagent",
      accountId: "ops",
      reason: "spawn-failed",
      sendFarewell: true,
    });

    expect(unbindMock).toHaveBeenCalledWith({
      bindingId: "ops:!room:example:$thread",
      reason: "spawn-failed",
    });
    expect(removeBindingRecordMock).not.toHaveBeenCalled();
    expect(getManagerMock).not.toHaveBeenCalled();
  });

  it("skips persist when removeBindingRecord returns false (binding not found in store)", async () => {
    const binding = makeBinding({ targetSessionKey: "agent:ops:subagent:orphan" });
    listBindingsForAccountMock.mockReturnValue([binding]);
    removeBindingRecordMock.mockReturnValue(false);

    await handleMatrixSubagentEnded({
      targetSessionKey: "agent:ops:subagent:orphan",
      targetKind: "subagent",
      accountId: "ops",
    });

    expect(getManagerMock).not.toHaveBeenCalled();
  });

  it("falls back to listAllBindings when accountId is absent", async () => {
    const binding = makeBinding();
    listAllBindingsMock.mockReturnValue([binding]);
    removeBindingRecordMock.mockReturnValue(true);
    getManagerMock.mockReturnValue(mockManager);
    mockManager.persist.mockResolvedValue(undefined);

    await handleMatrixSubagentEnded({
      targetSessionKey: "agent:ops:subagent:child",
      targetKind: "subagent",
    });

    expect(listAllBindingsMock).toHaveBeenCalled();
    expect(listBindingsForAccountMock).not.toHaveBeenCalled();
    expect(mockManager.persist).toHaveBeenCalled();
  });

  it("does not double-persist when multiple bindings share the same account", async () => {
    listBindingsForAccountMock.mockReturnValue([
      makeBinding({ conversationId: "$t1" }),
      makeBinding({ conversationId: "$t2" }),
    ]);
    removeBindingRecordMock.mockReturnValue(true);
    getManagerMock.mockReturnValue(mockManager);
    mockManager.persist.mockResolvedValue(undefined);

    await handleMatrixSubagentEnded({
      targetSessionKey: "agent:ops:subagent:child",
      targetKind: "subagent",
      accountId: "ops",
    });

    // persist must be called exactly once per unique accountId, not once per binding
    expect(mockManager.persist).toHaveBeenCalledTimes(1);
  });
});

describe("handleMatrixSubagentDeliveryTarget", () => {
  beforeEach(() => {
    listAllBindingsMock.mockReset();
    listBindingsForAccountMock.mockReset();
  });

  it("returns undefined when expectsCompletionMessage is false", () => {
    const result = handleMatrixSubagentDeliveryTarget(
      makeDeliveryEvent({ expectsCompletionMessage: false }),
    );
    expect(result).toBeUndefined();
  });

  it("returns undefined when requester channel is not matrix", () => {
    listBindingsForAccountMock.mockReturnValue([]);
    const result = handleMatrixSubagentDeliveryTarget(makeDeliveryEvent({ channel: "slack" }));
    expect(result).toBeUndefined();
  });

  it("returns undefined when no bindings match the child session key", () => {
    listBindingsForAccountMock.mockReturnValue([
      makeBinding({ targetSessionKey: "agent:ops:subagent:OTHER" }),
    ]);
    const result = handleMatrixSubagentDeliveryTarget(makeDeliveryEvent());
    expect(result).toBeUndefined();
  });

  it("returns origin with threadId when binding has a distinct parentConversationId", () => {
    const binding = makeBinding({ conversationId: "$thread123" });
    listBindingsForAccountMock.mockReturnValue([binding]);

    const result = handleMatrixSubagentDeliveryTarget(
      makeDeliveryEvent({ threadId: "$thread123" }),
    );

    expect(result).toEqual(makeDeliveryResult({ threadId: "$thread123" }));
  });

  it("returns origin without threadId when conversationId equals parentConversationId", () => {
    const binding = makeBinding({ conversationId: DEFAULT_ROOM_ID });
    listBindingsForAccountMock.mockReturnValue([binding]);

    const result = handleMatrixSubagentDeliveryTarget(makeDeliveryEvent());

    expect(result).toEqual(makeDeliveryResult());
    expect(result?.origin).not.toHaveProperty("threadId");
  });

  it("returns origin without threadId when binding has no parentConversationId", () => {
    const binding = makeBinding({
      conversationId: DEFAULT_ROOM_ID,
      parentConversationId: undefined,
    });
    listBindingsForAccountMock.mockReturnValue([binding]);

    const result = handleMatrixSubagentDeliveryTarget(makeDeliveryEvent());

    expect(result).toEqual(makeDeliveryResult());
  });

  it("falls back to the single binding when requesterOrigin threadId does not match any binding", () => {
    const binding = makeBinding({ conversationId: "$thread123" });
    listBindingsForAccountMock.mockReturnValue([binding]);

    const result = handleMatrixSubagentDeliveryTarget(
      makeDeliveryEvent({ threadId: "$threadOTHER" }),
    );

    // No threadId match, but single binding → falls back to it
    expect(result).toEqual(makeDeliveryResult({ threadId: "$thread123" }));
  });

  it("returns undefined when multiple bindings exist and threadId matches none", () => {
    listBindingsForAccountMock.mockReturnValue([
      makeBinding({ conversationId: "$t1" }),
      makeBinding({ conversationId: "$t2" }),
    ]);

    const result = handleMatrixSubagentDeliveryTarget(makeDeliveryEvent({ threadId: "$tNONE" }));

    expect(result).toBeUndefined();
  });

  it("uses listAllBindings when requesterOrigin has no accountId", () => {
    const binding = makeBinding({ conversationId: "$thread123" });
    listAllBindingsMock.mockReturnValue([binding]);

    const result = handleMatrixSubagentDeliveryTarget(makeDeliveryEvent({ accountId: undefined }));

    expect(listAllBindingsMock).toHaveBeenCalled();
    expect(listBindingsForAccountMock).not.toHaveBeenCalled();
    expect(result).toEqual(makeDeliveryResult({ threadId: "$thread123" }));
  });
});
