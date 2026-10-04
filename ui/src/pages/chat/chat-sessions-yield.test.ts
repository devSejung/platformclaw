// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { ChatItem } from "../../lib/chat/chat-types.ts";
import { extractToolCardsCached } from "../../lib/chat/tool-cards.ts";
import { latestSessionsYieldTimestamp, projectSessionsYieldItems } from "./chat-sessions-yield.ts";
import { buildChatItems } from "./chat-thread-build.ts";
import * as grouping from "./chat-thread-grouping.ts";

function createProps(
  overrides: Partial<Parameters<typeof buildChatItems>[0]> = {},
): Parameters<typeof buildChatItems>[0] {
  return {
    paneId: "yield-test",
    sessionKey: "agent:main:parent",
    messages: [],
    toolMessages: [],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    showToolCalls: true,
    ...overrides,
  };
}
const call = {
  type: "toolCall",
  id: "yield-call",
  name: "sessions_yield",
  arguments: {},
};
const result = {
  type: "toolResult",
  toolCallId: "yield-call",
  name: "sessions_yield",
  content: [{ type: "text", text: '{"status":"yielded"}' }],
};
const separateHistory = [
  { role: "assistant", runId: "parent-run", timestamp: 2_000, content: [call] },
  {
    role: "toolResult",
    runId: "parent-run",
    timestamp: 2_001,
    toolCallId: "yield-call",
    toolName: "sessions_yield",
    content: result.content,
  },
];
const nestedHistory = [
  {
    role: "custom",
    customType: "openclaw.nested-tool.v1",
    runId: "parent-run",
    timestamp: 2_000,
    content: [
      { ...call, parentToolCallId: "exec-call" },
      { ...result, parentToolCallId: "exec-call" },
    ],
  },
];

describe("sessions_yield transcript markers", () => {
  it.each([false, true])(
    "preserves non-yield item identity with showToolCalls=%s",
    (showToolCalls) => {
      const items = [
        {
          role: "assistant",
          content: [{ type: "text", text: "Implementation continues." }],
          activity: [],
        },
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "read", name: "read", arguments: { path: "README.md" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "read",
          toolName: "read",
          content: [{ type: "text", text: "Project documentation" }],
        },
      ].map(
        (message, index) =>
          ({ kind: "message", key: `ordinary:${index}`, message }) satisfies ChatItem,
      );
      const projected = projectSessionsYieldItems(items, undefined, showToolCalls);
      for (const [index, item] of items.entries()) {
        expect(projected[index]).toBe(item);
      }
      expect(projected).toHaveLength(items.length);
    },
  );

  it.each([
    ["separate call and result", separateHistory],
    ["nested exec activity", nestedHistory],
  ])("keeps %s visible with tool calls hidden", (_name, messages) => {
    const original = structuredClone(messages);
    const items = buildChatItems(createProps({ messages, showToolCalls: false }));
    expect(items).toEqual([
      expect.objectContaining({
        kind: "notice",
        text: "Handed off and waiting",
        timestamp: 2_000,
      }),
    ]);
    expect(latestSessionsYieldTimestamp(messages)).toBe(2_000);
    expect(latestSessionsYieldTimestamp(messages)).toBe(2_000);
    expect(messages).toEqual(original);
  });

  it.each([
    { role: "assistant", content: "Continuing the implementation.", timestamp: 3_000 },
    {
      role: "assistant",
      content: [{ type: "image", url: "https://example.invalid/proof.png" }],
      timestamp: 3_000,
    },
    { role: "user", content: "Continue.", timestamp: 3_000 },
  ])("marks the yield resumed after later $role activity", (later) => {
    const messages = [...separateHistory, later];
    const markers = buildChatItems(createProps({ messages })).filter(
      (item) => item.kind === "notice",
    );
    expect(markers).toEqual([expect.objectContaining({ text: "Resumed", timestamp: 2_000 })]);
    expect(latestSessionsYieldTimestamp(messages)).toBeNull();
  });

  it("marks the yield resumed when a new own run starts before its first output", () => {
    const items = buildChatItems(
      createProps({
        messages: separateHistory,
        runId: "resumed-run",
        runActive: true,
        runWorking: true,
        streamStartedAt: 3_000,
      }),
    );
    expect(items.find((item) => item.kind === "notice")).toMatchObject({ text: "Resumed" });
  });

  it.each([false, true])(
    "never displays private yield inputs before confirmation (failed=%s)",
    (failed) => {
      const messages = [
        {
          ...separateHistory[0],
          content: [{ ...call, arguments: { message: "PRIVATE_PENDING_CONTEXT" } }],
        },
        ...(failed
          ? [
              {
                ...separateHistory[1],
                isError: true,
                content: [{ type: "text", text: "Yield rejected" }],
              },
            ]
          : []),
      ];
      const original = structuredClone(messages);
      const items = buildChatItems(createProps({ messages, showToolCalls: true }));
      expect(JSON.stringify(items)).not.toContain("PRIVATE_PENDING_CONTEXT");
      expect(items.some((item) => item.kind === "notice")).toBe(false);
      if (failed) {
        expect(JSON.stringify(items)).toContain("Could not hand off the turn");
      }
      expect(messages).toEqual(original);
    },
  );

  it("keeps a nested yield waiting when its exec wrapper completes in the same run", () => {
    const messages = [
      ...nestedHistory,
      {
        role: "assistant",
        runId: "parent-run",
        timestamp: 2_010,
        content: [
          { type: "toolCall", id: "exec-call", name: "exec", arguments: {} },
          {
            type: "toolResult",
            toolCallId: "exec-call",
            name: "exec",
            content: [{ type: "text", text: "Done" }],
          },
        ],
      },
    ];
    const items = buildChatItems(createProps({ messages }));
    expect(items.find((item) => item.kind === "notice")).toMatchObject({
      text: "Handed off and waiting",
    });
    expect(latestSessionsYieldTimestamp(messages)).toBe(2_000);
  });

  it("preserves sibling tools and prose without displaying private yield arguments", () => {
    const messages = [
      {
        role: "assistant",
        timestamp: 2_000,
        content: [
          { type: "text", text: "Delegated implementation." },
          { type: "toolCall", id: "read-call", name: "read", arguments: { path: "README.md" } },
          { ...call, arguments: { message: "PRIVATE_CONTINUATION" } },
          result,
        ],
      },
    ];
    const items = buildChatItems(createProps({ messages }));
    expect(items.at(-1)).toMatchObject({ kind: "notice", text: "Handed off and waiting" });
    const remaining = items.flatMap((item) => (item.kind === "group" ? item.messages : []));
    expect(
      remaining.flatMap(({ message }) => extractToolCardsCached(message).map((card) => card.name)),
    ).toEqual(["read"]);
    expect(JSON.stringify(items)).toContain("Delegated implementation.");
    expect(JSON.stringify(items)).not.toContain("PRIVATE_CONTINUATION");
    const hidden = buildChatItems(createProps({ messages, showToolCalls: false }));
    expect(
      hidden.flatMap((item) =>
        item.kind === "group"
          ? item.messages.flatMap(({ message }) => extractToolCardsCached(message))
          : [],
      ),
    ).toEqual([]);
    expect(JSON.stringify(hidden)).toContain("Delegated implementation.");
  });

  it.each([
    [separateHistory[0]!],
    [separateHistory[1]!],
    [
      separateHistory[0]!,
      { ...separateHistory[1], content: [{ type: "text", text: '{"status":"error"}' }] },
    ],
  ])("requires a successful call/result pair", (...messages) => {
    expect(buildChatItems(createProps({ messages })).some((item) => item.kind === "notice")).toBe(
      false,
    );
    expect(latestSessionsYieldTimestamp(messages)).toBeNull();
    expect(buildChatItems(createProps({ messages, showToolCalls: false }))).toEqual([]);
  });
});

describe("yield privacy and lifecycle boundaries", () => {
  it("hides private continuation in an orphan successful result without inventing a handoff", () => {
    const messages = [
      {
        ...separateHistory[1],
        content: [
          { type: "text", text: JSON.stringify({ status: "yielded", message: "PRIVATE_ORPHAN" }) },
        ],
      },
    ];
    const items = buildChatItems(createProps({ messages }));
    expect(items).toEqual([]);
    expect(latestSessionsYieldTimestamp(messages)).toBeNull();
  });

  it("resumes older yields and keeps only the newest handoff waiting", () => {
    const messages = [
      ...separateHistory,
      { role: "assistant", content: "Checking the results", timestamp: 3_000 },
      {
        role: "assistant",
        runId: "second-run",
        timestamp: 4_000,
        content: [{ ...call, id: "second-yield" }],
      },
      { ...separateHistory[1], runId: "second-run", toolCallId: "second-yield", timestamp: 4_001 },
    ];
    const markers = buildChatItems(createProps({ messages })).filter(
      (item) => item.kind === "notice",
    );
    expect(markers.map((item) => item.sessionsYield)).toEqual(["resumed", "waiting"]);
    expect(latestSessionsYieldTimestamp(messages)).toBe(4_000);
  });
});

describe("yield error and implicit-call privacy", () => {
  it.each([undefined, "legacy-call"])(
    "hides implicit input shape %s and preserves sibling prose",
    (type) => {
      const messages = [
        {
          role: "assistant",
          timestamp: 2_000,
          content: [
            { type: "text", text: "Delegating work" },
            {
              type,
              id: "yield-call",
              name: "sessions_yield",
              arguments: { message: "PRIVATE_IMPLICIT" },
            },
          ],
        },
      ];
      const items = buildChatItems(createProps({ messages }));
      expect(JSON.stringify(items)).toContain("Delegating work");
      expect(JSON.stringify(items)).not.toContain("PRIVATE_IMPLICIT");
    },
  );

  it.each([false, true])("redacts echoed continuation from failed result (orphan=%s)", (orphan) => {
    const messages = [
      ...(orphan
        ? []
        : [
            {
              ...separateHistory[0],
              content: [{ ...call, arguments: { message: "PRIVATE_FAILED" } }],
            },
          ]),
      {
        ...separateHistory[1],
        isError: true,
        details: { status: "error", message: "PRIVATE_FAILED" },
        content: [{ type: "text", text: "Yield rejected: PRIVATE_FAILED" }],
      },
    ];
    const original = structuredClone(messages);
    const items = buildChatItems(createProps({ messages }));
    expect(JSON.stringify(items)).not.toContain("PRIVATE_FAILED");
    expect(JSON.stringify(items)).toContain("Could not hand off the turn");
    expect(items.some((item) => item.kind === "notice")).toBe(false);
    expect(buildChatItems(createProps({ messages, showToolCalls: false }))).toEqual([]);
    expect(messages).toEqual(original);
  });
});

describe("yield projection caching and bundled failures", () => {
  it("does not re-pair unchanged history for timer and session push updates", () => {
    const messages = [...separateHistory];
    const pair = vi.spyOn(grouping, "coalesceToolActivityMessages");
    try {
      expect(latestSessionsYieldTimestamp(messages)).toBe(2_000);
      expect(pair).toHaveBeenCalledTimes(1);
      expect(latestSessionsYieldTimestamp(messages)).toBe(2_000);
      expect(pair).toHaveBeenCalledTimes(1);
    } finally {
      pair.mockRestore();
    }
  });

  it("drops message-level error details while retaining bundled sibling prose", () => {
    const messages = [
      {
        role: "assistant",
        timestamp: 2_000,
        details: { status: "error", message: "PRIVATE_BUNDLED" },
        error: "PRIVATE_BUNDLED",
        errorMessage: "PRIVATE_BUNDLED",
        content: [
          { type: "text", text: "Delegation could not finish" },
          { ...call, arguments: { message: "PRIVATE_BUNDLED" } },
          { ...result, isError: true, content: [{ type: "text", text: "PRIVATE_BUNDLED" }] },
        ],
      },
    ];
    const original = structuredClone(messages);
    const items = buildChatItems(createProps({ messages }));
    expect(JSON.stringify(items)).toContain("Delegation could not finish");
    expect(JSON.stringify(items)).toContain("Could not hand off the turn");
    expect(JSON.stringify(items)).not.toContain("PRIVATE_BUNDLED");
    expect(messages).toEqual(original);
  });
});

describe("canonical yield pairing and ordering", () => {
  it.each(["toolCallId", "tool_call_id", "toolUseId", "tool_use_id"])(
    "pairs unnamed %s results before tool disclosure filtering",
    (field) => {
      const messages = [
        separateHistory[0],
        {
          role: "toolResult",
          [field]: "yield-call",
          timestamp: 2_001,
          content: result.content,
        },
      ];
      expect(buildChatItems(createProps({ messages, showToolCalls: false }))).toEqual([
        expect.objectContaining({ kind: "notice", sessionsYield: "waiting", timestamp: 2_000 }),
      ]);
      expect(latestSessionsYieldTimestamp(messages)).toBe(2_000);
      expect(
        buildChatItems(createProps({ messages: [messages[1]], showToolCalls: false })),
      ).toEqual([]);
    },
  );

  it("redacts failed unnamed paired results before hiding tools", () => {
    const messages = [
      separateHistory[0],
      {
        role: "toolResult",
        tool_call_id: "yield-call",
        isError: true,
        content: [{ type: "text", text: "PRIVATE_FAILED_UNNAMED" }],
      },
    ];
    expect(buildChatItems(createProps({ messages, showToolCalls: false }))).toEqual([]);
    expect(JSON.stringify(buildChatItems(createProps({ messages })))).not.toContain(
      "PRIVATE_FAILED_UNNAMED",
    );
  });

  it("leaves only the newest bundled handoff waiting", () => {
    const messages = [
      {
        role: "assistant",
        timestamp: 2_000,
        content: [
          call,
          result,
          { ...call, id: "second-yield" },
          { ...result, toolCallId: "second-yield" },
        ],
      },
    ];
    const markers = buildChatItems(createProps({ messages })).filter(
      (item) => item.kind === "notice",
    );
    expect(markers.map((item) => item.sessionsYield)).toEqual(["resumed", "waiting"]);
  });
});

it("keeps prose and confirmed yield while hiding paired sibling tools", () => {
  const messages = [
    {
      role: "assistant",
      timestamp: 2_000,
      content: [
        { type: "text", text: "Delegated work is underway" },
        { type: "toolCall", id: "read-sibling", name: "read", arguments: { path: "README.md" } },
        call,
      ],
    },
    { role: "toolResult", tool_call_id: "yield-call", timestamp: 2_001, content: result.content },
    {
      role: "toolResult",
      tool_call_id: "read-sibling",
      timestamp: 2_002,
      content: [{ type: "text", text: "SIBLING_TOOL_OUTPUT" }],
    },
  ];
  const items = buildChatItems(createProps({ messages, showToolCalls: false }));
  expect(JSON.stringify(items)).toContain("Delegated work is underway");
  expect(JSON.stringify(items)).not.toContain("SIBLING_TOOL_OUTPUT");
  expect(items.filter((item) => item.kind === "notice")).toMatchObject([
    { sessionsYield: "waiting" },
  ]);
  expect(
    items.flatMap((item) =>
      item.kind === "group"
        ? item.messages.flatMap(({ message }) => extractToolCardsCached(message))
        : [],
    ),
  ).toEqual([]);
});

it("does not expose an unnamed failed yield result when search filters out its call", () => {
  const messages = [
    {
      ...separateHistory[0],
      content: [{ ...call, arguments: { message: "PRIVATE_SEARCH_CONTEXT" } }],
    },
    {
      role: "toolResult",
      tool_call_id: "yield-call",
      isError: true,
      content: [{ type: "text", text: "Yield rejected: PRIVATE_SEARCH_CONTEXT" }],
      timestamp: 2_001,
    },
  ];
  const items = buildChatItems(
    createProps({
      messages,
      showToolCalls: true,
      searchOpen: true,
      searchQuery: "PRIVATE_SEARCH_CONTEXT",
    }),
  );
  expect(JSON.stringify(items)).not.toContain("PRIVATE_SEARCH_CONTEXT");
  expect(items).toEqual([]);
});
