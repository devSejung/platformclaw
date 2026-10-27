import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendTranscriptMessages,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import {
  resolveAgentRestartRecoveryChannelContext,
  resolveAgentRestartRecoveryExecutionIdentityAdmission,
  resolveAgentRestartRecoverySenderAgentId,
} from "./agent-restart-recovery-context.js";

const matchingParams = {
  canUseInternalRuntimeHandoff: true,
  expectedExistingSessionId: "session-1",
  resolvedSessionId: "session-1",
  runId: "recovery-run-1",
  sessionEntry: {
    sessionId: "session-1",
    updatedAt: 1,
    restartRecoveryDeliveryRunId: "recovery-run-1",
    restartRecoveryDeliverySourceRunId: "channel-user:v1:source-1",
    restartRecoveryDeliveryContext: {
      channel: "discord",
      to: "discord:dm:123",
      accountId: "work",
      threadId: "thread-1",
    },
    restartRecoveryRequesterAccountId: "work",
    restartRecoveryRequesterSenderId: "user-1",
    restartRecoverySameChannelThreadRequired: true,
    restartRecoverySourceIngress: "channel",
  },
} as const;

describe("resolveAgentRestartRecoveryChannelContext", () => {
  it("rehydrates the exact backend-owned recovery claim", () => {
    expect(resolveAgentRestartRecoveryChannelContext(matchingParams)).toEqual({
      channel: "discord",
      currentChannelId: "discord:dm:123",
      currentThreadTs: "thread-1",
      sourceTurnId: "channel-user:v1:source-1",
      requesterAccountId: "work",
      requesterSenderId: "user-1",
      sameChannelThreadRequired: true,
    });
  });

  it("does not promote a generic chat claim with channel delivery metadata", () => {
    expect(
      resolveAgentRestartRecoveryChannelContext({
        ...matchingParams,
        sessionEntry: {
          ...matchingParams.sessionEntry,
          restartRecoveryDeliveryContext: {
            channel: "discord",
            to: "discord:dm:123",
          },
          restartRecoverySourceIngress: undefined,
        },
      }),
    ).toBeUndefined();
  });

  it.each([
    { canUseInternalRuntimeHandoff: false },
    { expectedExistingSessionId: "session-2" },
    { resolvedSessionId: "session-2" },
    { runId: "recovery-run-2" },
    { sessionEntry: { ...matchingParams.sessionEntry, sessionId: "session-2" } },
    {
      sessionEntry: {
        ...matchingParams.sessionEntry,
        restartRecoveryDeliveryContext: undefined,
      },
    },
    {
      sessionEntry: {
        ...matchingParams.sessionEntry,
        restartRecoverySourceIngress: undefined,
      },
    },
    {
      sessionEntry: {
        ...matchingParams.sessionEntry,
        restartRecoveryDeliverySourceRunId: undefined,
      },
    },
  ])("rejects a non-matching or uncorrelated claim", (override) => {
    expect(
      resolveAgentRestartRecoveryChannelContext({ ...matchingParams, ...override }),
    ).toBeUndefined();
  });
});

describe("resolveAgentRestartRecoveryExecutionIdentityAdmission", () => {
  const token = {
    tokenVersion: 1 as const,
    contextId: "context-1",
    executionId: "execution-1",
    runId: "recovery-run-1",
    createdAt: 1,
  };

  it("rehydrates the durable token for capture and exact retry without runtime reconstruction", () => {
    const sessionEntry = {
      ...matchingParams.sessionEntry,
      mainRestartRecovery: {
        cycleId: "cycle-1",
        revision: 1,
        chargedAttempts: 1,
        executionIdentity: token,
      },
    };
    expect(
      resolveAgentRestartRecoveryExecutionIdentityAdmission({
        collectionEnabled: true,
        isRestartRecoveryResumeRun: true,
        retryOnly: false,
        runId: token.runId,
        sessionEntry,
      }),
    ).toEqual({ token, retryOnly: false });
    expect(
      resolveAgentRestartRecoveryExecutionIdentityAdmission({
        collectionEnabled: true,
        isRestartRecoveryResumeRun: true,
        retryOnly: true,
        runId: token.runId,
        sessionEntry,
      }),
    ).toEqual({ token, retryOnly: true });
  });

  it("returns no token for ordinary runs and refuses lost recovery evidence", () => {
    expect(
      resolveAgentRestartRecoveryExecutionIdentityAdmission({
        collectionEnabled: true,
        isRestartRecoveryResumeRun: false,
        retryOnly: false,
        runId: token.runId,
        sessionEntry: matchingParams.sessionEntry,
      }),
    ).toBeUndefined();
    expect(() =>
      resolveAgentRestartRecoveryExecutionIdentityAdmission({
        collectionEnabled: true,
        isRestartRecoveryResumeRun: true,
        retryOnly: true,
        runId: token.runId,
        sessionEntry: matchingParams.sessionEntry,
      }),
    ).toThrow("token is unavailable");
  });

  it("omits retained recovery identity while collection is disabled", () => {
    const sessionEntry = {
      ...matchingParams.sessionEntry,
      mainRestartRecovery: {
        cycleId: "cycle-1",
        revision: 1,
        chargedAttempts: 1,
        executionIdentity: token,
      },
    };
    expect(
      resolveAgentRestartRecoveryExecutionIdentityAdmission({
        collectionEnabled: false,
        isRestartRecoveryResumeRun: true,
        retryOnly: true,
        runId: token.runId,
        sessionEntry,
      }),
    ).toBeUndefined();
  });

  it("refuses an enabled recovery without an explicit capture or retry mode", () => {
    expect(() =>
      resolveAgentRestartRecoveryExecutionIdentityAdmission({
        collectionEnabled: true,
        isRestartRecoveryResumeRun: true,
        runId: token.runId,
        sessionEntry: matchingParams.sessionEntry,
      }),
    ).toThrow("admission mode is unavailable");
  });
});

const transcriptRoots: string[] = [];
afterEach(async () => {
  await Promise.all(
    transcriptRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("restart recovery personal Agent authority", () => {
  it.each([false, true, undefined])(
    "reads only the exact source turn with explicit non-owner authority (%s)",
    async (senderIsOwner) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "restart-agent-authority-"));
      transcriptRoots.push(root);
      const storePath = path.join(root, "agents", "main", "sessions", "sessions.json");
      const sessionKey = "agent:main:main";
      const sessionEntry = {
        sessionId: "scope-session",
        updatedAt: 1,
        restartRecoveryDeliveryRunId: "recovery",
        restartRecoveryDeliverySourceRunId: "source",
      };
      const scope = { agentId: "main", sessionKey, sessionId: sessionEntry.sessionId, storePath };
      await replaceSessionEntry(scope, sessionEntry);
      await appendTranscriptMessages(scope, {
        messages: [
          {
            message: {
              role: "user",
              content: "original profile request",
              idempotencyKey: "source:user",
              __openclaw: { senderIsOwner, senderAgentId: "main" },
            },
          },
          ...Array.from({ length: 25 }, (_, index) => ({
            message: { role: "assistant", content: `step ${index}` },
          })),
          {
            message: {
              role: "user",
              content: "unrelated latest request",
              idempotencyKey: "other:user",
              __openclaw: { senderIsOwner: false, senderAgentId: "foreign" },
            },
          },
        ],
      });
      await expect(
        resolveAgentRestartRecoverySenderAgentId({ ...scope, sessionEntry }),
      ).resolves.toBe(senderIsOwner === false ? "main" : undefined);
      await expect(
        resolveAgentRestartRecoverySenderAgentId({
          ...scope,
          sessionEntry: { ...sessionEntry, restartRecoveryDeliverySourceRunId: "missing" },
        }),
      ).resolves.toBeUndefined();
      await expect(
        resolveAgentRestartRecoverySenderAgentId({
          ...scope,
          sessionEntry: { ...sessionEntry, sessionId: "foreign-session" },
        }),
      ).resolves.toBeUndefined();
    },
  );
});
