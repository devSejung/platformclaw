import { expect, it, type Mock } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import type { FollowupRunnerParams } from "./followup-turn-admission.js";
import type { FollowupRun } from "./queue.js";

/** Reuses the admission suite's mocks and lifecycle setup for generation fault injection. */
export function registerFollowupPreflightGenerationFailureTests(harness: {
  admitFollowupTurn: typeof import("./followup-turn-admission.js").admitFollowupTurn;
  createOperation: (sessionId?: string) => { sessionId: string; updateSessionId: Mock };
  createRun: () => FollowupRun;
  createDefaults: (overrides?: Record<string, unknown>) => FollowupRunnerParams;
  state: { admitReply: Mock; preflight: Mock };
}) {
  const { admitFollowupTurn, createOperation, createRun, createDefaults, state } = harness;
  it.each(["session", "lifecycle"] as const)(
    "keeps the admitted %s generation when its predecessor resurfaces during a preflight failure",
    async (generation) => {
      const staleEntry: SessionEntry = {
        sessionId: "queued-session",
        lifecycleRevision: "old",
        updatedAt: 1,
      };
      const admittedEntry: SessionEntry = {
        sessionId: generation === "session" ? "admitted-session" : staleEntry.sessionId,
        lifecycleRevision: "current",
        updatedAt: 2,
      };
      const operation = createOperation(admittedEntry.sessionId);
      const sessionStore = { main: staleEntry };
      state.admitReply.mockResolvedValue({
        status: "owned",
        operation,
        sessionEntry: admittedEntry,
      });
      state.preflight.mockImplementation(async ({ sessionEntry }) => {
        expect(sessionEntry).toBe(admittedEntry);
        await Promise.resolve();
        sessionStore.main = staleEntry;
        throw new Error("preflight failed after concurrent predecessor publication");
      });

      const result = await admitFollowupTurn({
        queued: createRun(),
        defaults: createDefaults({ sessionEntry: staleEntry, sessionStore }),
      });

      expect(result).toMatchObject({
        kind: "admitted",
        turn: {
          queued: { run: { sessionId: admittedEntry.sessionId } },
          preflightFailurePayload: { isError: true },
        },
      });
      if (result.kind === "admitted") {
        expect(result.turn.session.current()).toBe(admittedEntry);
      }
      expect(operation.updateSessionId).not.toHaveBeenCalled();
    },
  );
}
