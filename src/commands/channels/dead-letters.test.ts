// Channels dead-letter command tests exercise the operator-visible recovery path.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createChannelIngressQueue } from "../../channels/message/ingress-queue.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { RuntimeEnv } from "../../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createChannelTestPluginBase } from "../../test-utils/channel-plugins.js";
import {
  channelsDeadLettersListCommand,
  channelsDeadLettersResubmitCommand,
} from "./dead-letters.js";

const originalStateDir = process.env.OPENCLAW_STATE_DIR;
vi.mock("../../channels/plugins/index.js", () => ({ getChannelPlugin: vi.fn() }));

async function withTempState(run: (stateDir: string) => Promise<void>): Promise<void> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-channel-dead-letters-"));
  process.env.OPENCLAW_STATE_DIR = stateDir;
  try {
    await run(stateDir);
  } finally {
    closeOpenClawStateDatabaseForTest();
    vi.mocked(getChannelPlugin).mockReset();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

function createRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  } as unknown as RuntimeEnv;
}

describe("channel dead-letter commands", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
  });

  it("lists retained failures as JSON", async () => {
    await withTempState(async () => {
      const queue = createChannelIngressQueue<{ text: string }>({
        channelId: "telegram",
        accountId: "ops",
      });
      await queue.enqueue("event-1", { text: "recover me" });
      const claim = await queue.claim("event-1", { ownerId: "worker" });
      if (!claim) {
        throw new Error("Expected a claimed ingress event");
      }
      await queue.fail(claim, { reason: "handler-error", failedAt: 20 });
      const runtime = createRuntime();

      await channelsDeadLettersListCommand(
        { channel: "telegram", account: "ops", json: true },
        runtime,
      );

      const output = JSON.parse(String(vi.mocked(runtime.log).mock.calls[0]?.[0])) as {
        deadLetters: Array<{ id: string; payload?: unknown; reason: string }>;
      };
      expect(output.deadLetters).toEqual([
        expect.objectContaining({
          id: "event-1",
          payload: { text: "recover me" },
          reason: "handler-error",
        }),
      ]);
    });
  });

  it("resubmits through the queue API and reports completed events as terminal", async () => {
    await withTempState(async () => {
      const queue = createChannelIngressQueue<{ text: string }>({ channelId: "line" });
      await queue.enqueue("event-1", { text: "once" });
      const claim = await queue.claim("event-1", { ownerId: "worker" });
      if (!claim) {
        throw new Error("Expected a claimed ingress event");
      }
      await queue.fail(claim, { reason: "handler-error", failedAt: 20 });
      const runtime = createRuntime();

      await channelsDeadLettersResubmitCommand("event-1", { channel: "line" }, runtime);
      const replay = await queue.claimNext({ ownerId: "replay-worker" });
      expect(replay).toMatchObject({ id: "event-1", payload: { text: "once" } });
      expect(replay?.admissionAheadCount).toBeUndefined();
      if (!replay) {
        throw new Error("Expected a resubmitted ingress event");
      }
      await queue.complete(replay, { completedAt: 40 });

      await expect(
        channelsDeadLettersResubmitCommand("event-1", { channel: "line" }, runtime),
      ).rejects.toThrow("is completed and cannot be resubmitted");
    });
  });

  it.each(["knox", "synthetic-arrival"])(
    "uses %s channel policy to append a legacy failure after sequenced backlog",
    async (channelId) => {
      await withTempState(async () => {
        vi.mocked(getChannelPlugin).mockReturnValue({
          ...createChannelTestPluginBase({ id: channelId }),
          ingressQueue: { orderBy: "admission" },
        });
        const legacy = createChannelIngressQueue<string>({ channelId });
        await legacy.enqueue("F", "retained legacy payload", { receivedAt: 1, laneKey: "room" });
        const failed = await legacy.claim("F");
        if (!failed) {
          throw new Error("Expected a legacy claim");
        }
        await legacy.fail(failed, { reason: "synthetic" });
        const queue = createChannelIngressQueue<string>({ channelId, sequencedAdmission: true });
        await queue.enqueue("B", "new request", { receivedAt: 2, laneKey: "room" });
        await channelsDeadLettersResubmitCommand("F", { channel: channelId }, createRuntime());
        expect((await queue.listPending({ orderBy: "admission" })).map((row) => row.id)).toEqual([
          "B",
          "F",
        ]);
        for (const id of ["B", "F"]) {
          const claim = await queue.claimNext({ orderBy: "admission", scanLimit: 1 });
          expect(claim?.id).toBe(id);
          if (!claim) {
            throw new Error("Expected a replay claim");
          }
          await queue.complete(claim);
        }
      });
    },
  );
});
