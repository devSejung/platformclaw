import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { replaceSessionEntry } from "../../../src/config/sessions/session-accessor.js";
import { projectChatDisplayMessages } from "../../../src/gateway/chat-display-projection.js";
import { appendInjectedAssistantMessageToTranscript } from "../../../src/gateway/server-methods/chat-transcript-inject.js";
import { closeOpenClawAgentDatabasesForTest } from "../../../src/state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../../src/state/openclaw-state-db.js";
import type { SpaceConversation } from "./space-contracts.js";
import { createSpaceTestFixture } from "./spaces.test-fixtures.js";

it.each([true, false])(
  "projects gateway-injected answers according to the abort marker (aborted: %s)",
  async (aborted) => {
    const f = await createSpaceTestFixture();
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "viewer", 1);
    const conversation = await f.proxy.request<SpaceConversation>(
      f.alice.token,
      "platformclaw.spaces.conversation.create",
      {
        spaceId: f.space.id,
        pageId: f.page.id,
        title: "Alice work",
        requestId: "audit-abort",
      },
    );
    const dir = mkdtempSync(join(tmpdir(), "space-audit-abort-"));
    try {
      const storePath = join(dir, "sessions.json");
      const scope = {
        agentId: f.alice.binding.agentId,
        sessionKey: conversation.sessionKey,
        sessionId: "audit-aborted-session",
        storePath,
      };
      await replaceSessionEntry(
        { agentId: scope.agentId, sessionKey: scope.sessionKey, storePath },
        { sessionId: scope.sessionId, updatedAt: Date.now() },
      );
      const emitted = await appendInjectedAssistantMessageToTranscript({
        ...scope,
        message: "Interrupted private draft before the user stopped this turn",
        idempotencyKey: "audit:assistant",
        ...(aborted
          ? { abortMeta: { aborted: true as const, origin: "rpc" as const, runId: "audit" } }
          : {}),
      });
      expect(emitted.ok).toBe(true);
      const actualHistory = projectChatDisplayMessages(
        [{ ...emitted.message, __openclaw: { id: emitted.messageId } }],
        { maxChars: 16000 },
      );
      // Personal history retains stopped content; only shared final-answer recall excludes it.
      expect(actualHistory).toHaveLength(1);
      expect(actualHistory[0]).toMatchObject({
        stopReason: "stop",
        ...(aborted ? { openclawAbort: { aborted: true } } : {}),
      });
      f.request.mockResolvedValueOnce({
        sessionKey: conversation.sessionKey,
        messages: actualHistory,
      });
      const recall = await f.service.agentRead({
        agentId: f.bob.binding.agentId,
        operation: "get",
        spaceId: f.space.id,
        pageId: f.page.id,
        conversationId: conversation.id,
      });
      if (aborted) {
        expect(recall.messages).toEqual([]);
      } else {
        expect(recall.messages).toMatchObject([
          { text: "Interrupted private draft before the user stopped this turn" },
        ]);
      }
      f.request.mockImplementation(async (method) =>
        method === "sessions.search"
          ? { results: [{ sessionKey: conversation.sessionKey, messageId: emitted.messageId }] }
          : { sessionKey: conversation.sessionKey, messages: actualHistory },
      );
      const search = await f.service.agentRead({
        agentId: f.bob.binding.agentId,
        operation: "search",
        query: "Interrupted",
        spaceId: f.space.id,
      });
      if (aborted) {
        expect(search).toMatchObject({ results: [], count: 0 });
      } else {
        expect(search).toMatchObject({ count: 1 });
      }
    } finally {
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
