import { expect, test, vi } from "vitest";
import { testState } from "./test-helpers.js";
import {
  directSessionReq,
  setupGatewaySessionsTestHarness,
} from "./test/server-sessions.test-helpers.js";

const initializer = vi.hoisted(() =>
  vi.fn(async (params: { entry: Record<string, unknown> }) => ({
    ...params.entry,
    initializationPending: undefined,
    initializationOwner: undefined,
  })),
);
vi.mock("./server-methods/visible-acp-session-create.js", () => ({
  initializeVisibleAcpCreatedSession: initializer,
}));
// This suite owns creation/cwd authorization; manager and turn execution have
// their own runtime proofs, so do not require a live chat runtime in this harness.
vi.mock("./server-methods/chat.js", () => ({
  chatHandlers: {
    "chat.send": async ({ respond }: { respond: (ok: boolean, payload: unknown) => void }) => {
      respond(true, { runId: "personal-acp-test", status: "started" });
    },
  },
}));

setupGatewaySessionsTestHarness();

test.each(["main", "another-owner"])(
  "personal ACP cwd checks trusted owner %s before local containment",
  async (executionOwnerAgentId) => {
    testState.agentConfig = { workspace: "/tmp/gateway-workspace", sandbox: { mode: "all" } };
    initializer.mockClear();
    try {
      const parent = await directSessionReq<{ key: string }>("sessions.create", {
        agentId: "main",
      });
      expect(parent.ok, JSON.stringify(parent)).toBe(true);
      const parentSessionKey = parent.payload!.key;
      const response = await directSessionReq(
        "sessions.create",
        {
          agentId: "main",
          spawnDepth: 1,
          parentSessionKey,
          task: "hello",
          cwd: "/users/person/project",
        },
        {
          client: {
            connect: { scopes: ["operator.admin"] },
            internal: {
              agentRuntimeIdentity: {
                kind: "agentRuntime",
                agentId: "main",
                sessionKey: parentSessionKey,
                sessionSpawnContext: {
                  inheritedToolPolicy: { version: 1, allow: [], deny: [] },
                  acpInitialization: {
                    logicalAgentId: "main",
                    runtimeAgentId: "codex",
                    executionOwnerAgentId,
                  },
                },
              },
            },
          } as never,
        },
      );
      if (executionOwnerAgentId === "main") {
        expect(response.ok, JSON.stringify(response)).toBe(true);
        expect(initializer).toHaveBeenCalledWith(
          expect.objectContaining({
            agentId: "main",
            intent: expect.objectContaining({ executionOwnerAgentId: "main" }),
            entry: expect.objectContaining({ spawnedCwd: "/users/person/project" }),
          }),
        );
      } else {
        expect(response).toMatchObject({
          ok: false,
          error: { message: "invalid trusted visible ACP session creation" },
        });
        expect(initializer).not.toHaveBeenCalled();
      }
    } finally {
      testState.agentConfig = undefined;
    }
  },
);

test("ordinary dashboard cwd still uses local sandbox containment", async () => {
  testState.agentConfig = { workspace: "/tmp/gateway-workspace", sandbox: { mode: "all" } };
  try {
    const response = await directSessionReq("sessions.create", { cwd: "/users/person/project" });
    expect(response).toMatchObject({
      ok: false,
      error: { message: "sessions.create cwd is outside the sandboxed agent workspace" },
    });
  } finally {
    testState.agentConfig = undefined;
  }
});
