import { expect, it, vi } from "vitest";
import {
  clearActiveEmbeddedRun,
  queueEmbeddedAgentMessageWithOutcomeAsync,
  setActiveEmbeddedRun,
} from "./runs.js";

it.each([
  { activeScope: "alice", incomingScope: undefined, queued: false },
  { activeScope: undefined, incomingScope: "alice", queued: false },
  { activeScope: "alice", incomingScope: "bob", queued: false },
  { activeScope: "alice", incomingScope: "alice", queued: true },
  { activeScope: undefined, incomingScope: undefined, queued: true },
])(
  "steers only within the same personal automation scope ($activeScope/$incomingScope)",
  async ({ activeScope, incomingScope, queued }) => {
    const queueMessage = vi.fn(async () => {});
    const sessionId = "personal-automation-steering";
    const handle = {
      queueMessage,
      isStreaming: () => true,
      isCompacting: () => false,
      abort: () => {},
      personalAutomationsAgentId: activeScope,
    };
    setActiveEmbeddedRun(sessionId, handle);
    try {
      const outcome = await queueEmbeddedAgentMessageWithOutcomeAsync(
        sessionId,
        "continue",
        incomingScope ? { personalAutomationsAgentId: incomingScope } : undefined,
      );
      if (queued) {
        expect(outcome.queued).toBe(true);
        expect(queueMessage).toHaveBeenCalledOnce();
      } else {
        expect(outcome).toMatchObject({
          queued: false,
          reason: "personal_automations_scope_mismatch",
        });
        expect(queueMessage).not.toHaveBeenCalled();
      }
    } finally {
      clearActiveEmbeddedRun(sessionId, handle);
    }
  },
);
