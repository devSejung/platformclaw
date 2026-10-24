import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  appendTranscriptMessageSync,
  loadTranscriptEvents,
  readSessionTranscriptWatermark,
  replaceSessionEntry,
  withTranscriptWriteLock,
} from "../../config/sessions/session-accessor.js";
import { createDeferred } from "../../test-utils/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  appendAssistantTranscriptMessage,
  rewriteAssistantTranscriptMessageByIdempotencyKey,
  rewriteAssistantTranscriptMessageByTurnIndexAndMedia,
  rewriteSourceReplyTranscriptMirrors,
} from "./chat-transcript-persistence.js";

describe("attachment publication authority at the SQLite writer", () => {
  it.each(["append", "idempotency", "turn", "source-mirror"] as const)(
    "revalidates %s after a queued writer finishes and preserves the previous transcript",
    async (operation) => {
      await withOpenClawTestState(
        { prefix: "transcript-publication-authority-" },
        async (state) => {
          const scope = {
            agentId: "main",
            sessionId: "authority-session",
            sessionKey: "agent:main:main",
            storePath: path.join(state.sessionsDir(), "sessions.sqlite"),
          };
          await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: Date.now() });
          appendTranscriptMessageSync(scope, {
            eventId: "original",
            message: {
              role: "assistant",
              provider: "openclaw",
              model: "delivery-mirror",
              idempotencyKey: "attachment-result",
              content: [{ type: "text", text: "Original\nMEDIA:/tmp/report.txt" }],
            },
          });
          const original = await loadTranscriptEvents(scope);
          const watermark = readSessionTranscriptWatermark(scope);
          const acquired = createDeferred();
          const release = createDeferred();
          const blocker = withTranscriptWriteLock(scope, async () => {
            acquired.resolve();
            await release.promise;
          });
          await acquired.promise;
          let current = true;
          const authority = vi.fn(async () => {
            if (!current) {
              throw new Error("attachment producer revoked while queued");
            }
          });
          const content = [
            { type: "attachment", attachment: { kind: "document", url: "/api/example" } },
          ];
          const pending =
            operation === "append"
              ? appendAssistantTranscriptMessage({
                  ...scope,
                  message: "New",
                  content,
                  beforeWrite: authority,
                })
              : operation === "idempotency"
                ? rewriteAssistantTranscriptMessageByIdempotencyKey({
                    scope,
                    idempotencyKey: "attachment-result",
                    content,
                    beforeRewrite: authority,
                  })
                : operation === "turn"
                  ? rewriteAssistantTranscriptMessageByTurnIndexAndMedia({
                      scope,
                      afterSeq: 0,
                      assistantMessageIndex: 1,
                      mediaUrls: ["/tmp/report.txt"],
                      content,
                      expectedGeneration: watermark.generation,
                      beforeRewrite: authority,
                    })
                  : rewriteSourceReplyTranscriptMirrors({
                      scope,
                      beforeRewrite: authority,
                      candidates: [{ idempotencyKey: "attachment-result", metadata: undefined }],
                      requests: [
                        {
                          idempotencyKey: "attachment-result",
                          metadata: undefined,
                          state: {
                            broadcastContent: content,
                            persistedContent: content,
                            hasManagedOutgoingContent: true,
                            backedManagedOutgoingContent: true,
                          },
                        },
                      ],
                    });
          const outcome = pending.then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          );
          expect(authority).not.toHaveBeenCalled();
          current = false;
          release.resolve();
          await blocker;
          const result = await outcome;
          expect(authority).toHaveBeenCalledOnce();
          if (operation === "append") {
            expect(result).toMatchObject({
              value: { ok: false, error: expect.stringContaining("producer revoked") },
            });
          } else {
            expect(result).toMatchObject({
              error: new Error("attachment producer revoked while queued"),
            });
          }
          expect(await loadTranscriptEvents(scope)).toEqual(original);
        },
      );
    },
  );
});
