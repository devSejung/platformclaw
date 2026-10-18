import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  claimPendingAgentQuestionAnswer,
  runAgentHarnessGatewayQuestion,
  type AgentHarnessUserInputQuestion,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { hasPendingAgentQuestionAnswer } from "openclaw/plugin-sdk/channel-inbound";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createKnoxIngress } from "./ingress.js";
import { isKnoxPendingQuestionReply, resolveKnoxPendingQuestionText } from "./input-routing.js";
import type { KnoxInboundMessage, ResolvedKnoxAccount } from "./types.js";

const account: ResolvedKnoxAccount = {
  accountId: "synthetic",
  enabled: true,
  configured: true,
  webhookPath: "/knox",
  webhookSecret: "w".repeat(32),
  outboundUrl: "http://relay.invalid/send",
  serviceToken: "s".repeat(32),
  controlPlaneUrl: "http://control.invalid/route",
  progressDelayMs: 60_000,
};
function message(id: string, text: string): KnoxInboundMessage {
  return {
    schemaVersion: 1,
    eventId: `event-${id}`,
    messageId: id,
    occurredAt: new Date(0).toISOString(),
    sender: { knoxUserId: "person.one", displayName: "Person One" },
    conversation: { type: "room", providerType: "GROUP", conversationId: "room-1" },
    message: { type: "text", text },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
afterEach(() => {
  vi.unstubAllGlobals();
  closeOpenClawStateDatabaseForTest();
});

describe("Knox live input lanes", () => {
  it.each([
    {
      name: "multiselect",
      questions: [
        {
          id: "action",
          header: "Action",
          question: "Choose actions",
          multiSelect: true,
          options: [{ label: "Continue" }, { label: "Cancel" }],
        },
      ],
      text: "@PlatformClaw 1\n2",
      candidate: "1\n2",
      invalid: ["@PlatformClaw 9\n2", "9\n2"],
      answers: { action: ["Continue", "Cancel"] } as Record<string, string[]>,
    },
    {
      name: "keyed questions",
      questions: [
        {
          id: "action",
          header: "Action",
          question: "Choose action",
          options: [{ label: "Continue" }, { label: "Cancel" }],
        },
        {
          id: "mode",
          header: "Mode",
          question: "Choose mode",
          options: [{ label: "Quick" }, { label: "Detailed" }],
        },
      ],
      text: "transport metadata\n@PlatformClaw action: 1\nmode: 2",
      candidate: "action: 1\nmode: 2",
      invalid: ["@PlatformClaw action: 9\nmode: 2", "action: 9\nmode: 2"],
      answers: { action: ["Continue"], mode: ["Detailed"] } as Record<string, string[]>,
    },
  ] satisfies Array<{
    name: string;
    questions: AgentHarnessUserInputQuestion[];
    text: string;
    candidate: string;
    invalid: string[];
    answers: Record<string, string[]>;
  }>)("preserves every mentioned answer for $name", async (testCase) => {
    const sessionKey = `agent:room:mentioned-${testCase.name}`;
    const prompted = deferred<void>();
    const answer = deferred<{
      status: "answered";
      answers: { answers: Record<string, string[]> };
    }>();
    const run = runAgentHarnessGatewayQuestion({
      sessionKey,
      questions: testCase.questions,
      timeoutMs: 60_000,
      gatewayCall: async (method, _opts, params) => {
        if (method === "question.request") {
          return { id: (params as { id: string }).id };
        }
        if (method === "question.waitAnswer") {
          return await answer.promise;
        }
        if (method === "question.resolve") {
          const result = {
            status: "answered" as const,
            answers: (params as { answers: { answers: Record<string, string[]> } }).answers,
          };
          answer.resolve(result);
          return result;
        }
        throw new Error(`Unexpected method ${method}`);
      },
      delivery: {
        onBlockReply: async () => {
          prompted.resolve();
        },
      },
    });
    try {
      await prompted.promise;
      for (const text of testCase.invalid) {
        expect(resolveKnoxPendingQuestionText({ sessionKey, text })).toBeUndefined();
      }
      const text = resolveKnoxPendingQuestionText({ sessionKey, text: testCase.text });
      expect(text).toBe(testCase.candidate);
      expect(await claimPendingAgentQuestionAnswer({ sessionKey, text: text ?? "" })).toBe(true);
      await expect(run).resolves.toEqual({
        status: "answered",
        answers: { answers: testCase.answers },
      });
    } finally {
      answer.resolve({ status: "answered", answers: { answers: testCase.answers } });
      await run;
    }
  });

  it("preserves the entire accepted free-form answer before considering transport decoration", async () => {
    const sessionKey = "agent:room:free-form-input";
    const prompted = deferred<void>();
    const answer = deferred<{
      status: "answered";
      answers: { answers: Record<string, string[]> };
    }>();
    const run = runAgentHarnessGatewayQuestion({
      sessionKey,
      timeoutMs: 60_000,
      questions: [
        { id: "answer", header: "Answer", question: "What should happen?", isOther: true },
      ],
      gatewayCall: async (method, _opts, params) => {
        if (method === "question.request") {
          return { id: (params as { id: string }).id };
        }
        if (method === "question.waitAnswer") {
          return await answer.promise;
        }
        if (method === "question.resolve") {
          const result = {
            status: "answered" as const,
            answers: (params as { answers: { answers: Record<string, string[]> } }).answers,
          };
          answer.resolve(result);
          return result;
        }
        throw new Error(`Unexpected method ${method}`);
      },
      delivery: {
        onBlockReply: async () => {
          prompted.resolve();
        },
      },
    });
    const text = "Preserve this context:\n@PlatformClaw keep everything";
    try {
      await prompted.promise;
      expect(resolveKnoxPendingQuestionText({ sessionKey, text })).toBe(text);
      expect(await claimPendingAgentQuestionAnswer({ sessionKey, text })).toBe(true);
      await expect(run).resolves.toEqual({
        status: "answered",
        answers: { answers: { answer: [text] } },
      });
    } finally {
      answer.resolve({ status: "answered", answers: { answers: { answer: [text] } } });
      await run;
    }
  });

  it.each(["1", "@PlatformClaw 1", "transport metadata\n@PlatformClaw 1"])(
    "delivers %s through the held FIFO and resumes the question owner",
    async (replyText) => {
      const stateDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "knox-input-")));
      const queue = createChannelIngressQueueForTests<{ version: 1; rawEvent: string }>({
        channelId: "knox",
        accountId: account.accountId,
        stateDir,
      });
      const sessionKey = "agent:room:knox-question";
      const answer = deferred<{
        status: "answered";
        answers: { answers: Record<string, string[]> };
      }>();
      const prompted = deferred<void>();
      const started: string[] = [];
      const observed: string[] = [];
      let questionRun: Promise<unknown> | undefined;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json({
            status: "resolved",
            agentId: "room",
            sessionKey,
            senderLinked: false,
            executionTarget: null,
          }),
        ),
      );
      const ingress = createKnoxIngress({
        accountId: account.accountId,
        queue,
        isPendingQuestionReply: async (raw) =>
          await isKnoxPendingQuestionReply({ account, message: raw }),
        dispatch: async (raw, lifecycle) => {
          started.push(raw.messageId);
          await lifecycle.onAdopted();
          if (raw.messageId === "first") {
            questionRun = runAgentHarnessGatewayQuestion({
              sessionKey,
              timeoutMs: 60_000,
              questions: [
                {
                  id: "action",
                  header: "Action",
                  question: "Continue?",
                  options: [{ label: "Continue" }, { label: "Cancel" }],
                },
              ],
              gatewayCall: async (method, _options, params) => {
                if (method === "question.request") {
                  return { id: (params as { id: string }).id };
                }
                if (method === "question.waitAnswer") {
                  return await answer.promise;
                }
                if (method === "question.resolve") {
                  const answers = (params as { answers?: { answers: Record<string, string[]> } })
                    .answers;
                  if (!answers) {
                    return { status: "cancelled" };
                  }
                  const result = { status: "answered" as const, answers };
                  answer.resolve(result);
                  return result;
                }
                throw new Error(`Unexpected method ${method}`);
              },
              delivery: {
                onBlockReply: async (payload) => {
                  observed.push(payload.text ?? "");
                  prompted.resolve();
                },
              },
            });
            const result = await questionRun;
            observed.push(JSON.stringify(result));
          } else if (raw.messageId === "answer") {
            expect(
              await claimPendingAgentQuestionAnswer({
                sessionKey,
                text:
                  resolveKnoxPendingQuestionText({ sessionKey, text: raw.message.text }) ??
                  raw.message.text,
              }),
            ).toBe(true);
          } else {
            observed.push("ordinary complete");
          }
        },
      });
      ingress.start();
      try {
        await ingress.admit(message("first", "start"));
        await prompted.promise;
        expect(
          resolveKnoxPendingQuestionText({ sessionKey, text: "@PlatformClaw 9" }),
        ).toBeUndefined();
        expect(
          resolveKnoxPendingQuestionText({
            sessionKey: "agent:other:main",
            text: "@PlatformClaw 1",
          }),
        ).toBeUndefined();
        expect(
          resolveKnoxPendingQuestionText({ sessionKey, text: "unrelated ordinary request" }),
        ).toBeUndefined();
        const reply = message("answer", "1");
        vi.mocked(fetch).mockResolvedValueOnce(
          Response.json({
            status: "resolved",
            agentId: "other",
            sessionKey: "agent:other:main",
            senderLinked: true,
            executionTarget: null,
          }),
        );
        expect(await isKnoxPendingQuestionReply({ account, message: reply })).toBe(false);
        vi.mocked(fetch).mockResolvedValueOnce(Response.json({ status: "room-disabled" }));
        expect(await isKnoxPendingQuestionReply({ account, message: reply })).toBe(false);
        expect(
          await isKnoxPendingQuestionReply({
            account,
            message: {
              ...reply,
              conversation: { type: "dm", providerType: "SINGLE", conversationId: "personal-1" },
            },
          }),
        ).toBe(false);
        await ingress.admit(message("ordinary", "another task"));
        expect(started).toEqual(["first"]);
        await ingress.admit(message("answer", replyText));
        await vi.waitFor(() => expect(observed).toContain("ordinary complete"));
        expect(started).toEqual(["first", "answer", "ordinary"]);
        expect(observed[0]).toContain("1. Continue");
        expect(observed[1]).toBe(
          JSON.stringify({ status: "answered", answers: { answers: { action: ["Continue"] } } }),
        );
        expect(hasPendingAgentQuestionAnswer({ sessionKey, text: "1" })).toBe(false);
      } finally {
        answer.resolve({ status: "answered", answers: { answers: { action: ["Continue"] } } });
        await questionRun;
        await ingress.stop();
        closeOpenClawStateDatabaseForTest();
        await fs.rm(stateDir, { recursive: true, force: true });
      }
    },
  );

  it.each(["/approve approval-1 allow-once", "/stop"])(
    "lets %s reach a held run while normal work stays queued",
    async (command) => {
      const stateDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "knox-control-")));
      const queue = createChannelIngressQueueForTests<{ version: 1; rawEvent: string }>({
        channelId: "knox",
        accountId: account.accountId,
        stateDir,
      });
      const release = deferred<void>();
      const started: string[] = [];
      const ingress = createKnoxIngress({
        accountId: account.accountId,
        queue,
        dispatch: async (raw, lifecycle) => {
          started.push(raw.messageId);
          await lifecycle.onAdopted();
          if (raw.messageId === "first") {
            await release.promise;
          }
          if (raw.messageId === "control") {
            release.resolve();
          }
        },
      });
      ingress.start();
      try {
        await ingress.admit(message("first", "start"));
        await vi.waitFor(() => expect(started).toEqual(["first"]));
        await ingress.admit(message("ordinary", "another task"));
        await ingress.admit(message("control", `metadata\n@bot ${command}`));
        await vi.waitFor(() => expect(started).toEqual(["first", "control", "ordinary"]));
      } finally {
        release.resolve();
        await ingress.stop();
        closeOpenClawStateDatabaseForTest();
        await fs.rm(stateDir, { recursive: true, force: true });
      }
    },
  );
});
