// Prompt media carrier tests cover collect batching, deferral, and retry identity.
import { afterEach, describe, expect, it } from "vitest";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { enqueueFollowupRun, FollowupRunDeferredError, scheduleFollowupDrain } from "./queue.js";
import { createDeferred, createQueueTestRun } from "./queue.test-helpers.js";
import { createOverflowSummaryRetrySource } from "./queue/drain.js";
import { clearFollowupQueue } from "./queue/state.js";

const queueKeys = new Set<string>();

afterEach(() => {
  for (const key of queueKeys) {
    clearFollowupQueue(key);
  }
  queueKeys.clear();
});

describe("followup prompt media carrier", () => {
  it("keeps collected prompt bytes and ordered facts stable across deferred admission", async () => {
    const key = `prompt-media-collect-${Date.now()}`;
    queueKeys.add(key);
    const settings: QueueSettings = { mode: "collect", debounceMs: 0 };
    const done = createDeferred<void>();
    const calls: FollowupRun[] = [];

    for (const [prompt, path, contentType] of [
      ["[media attached: /tmp/a.png (image/png)]\nfirst", "/tmp/a.png", "image/png"],
      ["[media attached: /tmp/b.pdf (application/pdf)]\nsecond", "/tmp/b.pdf", "application/pdf"],
    ] as const) {
      const run = createQueueTestRun({ prompt });
      run.media = [{ path, contentType }];
      run.workspaceMedia = [
        {
          path: `media/inbound/${path.split("/").at(-1)}`,
          contentType,
          workspaceDir: "/workspace",
        },
      ];
      enqueueFollowupRun(key, run, settings);
    }

    scheduleFollowupDrain(key, async (run) => {
      calls.push(run);
      if (calls.length === 1) {
        throw new FollowupRunDeferredError();
      }
      done.resolve();
    });
    await done.promise;

    const expectedPrompt = [
      "[Queued messages while agent was busy]",
      "---\nQueued #1\n[media attached: /tmp/a.png (image/png)]\nfirst",
      "---\nQueued #2\n[media attached: /tmp/b.pdf (application/pdf)]\nsecond",
    ].join("\n\n");
    expect(calls).toHaveLength(2);
    expect(calls.map((run) => run.prompt)).toEqual([expectedPrompt, expectedPrompt]);
    expect(calls.map((run) => run.media)).toEqual([
      [
        { path: "/tmp/a.png", contentType: "image/png" },
        { path: "/tmp/b.pdf", contentType: "application/pdf" },
      ],
      [
        { path: "/tmp/a.png", contentType: "image/png" },
        { path: "/tmp/b.pdf", contentType: "application/pdf" },
      ],
    ]);
    expect(calls.map((run) => run.workspaceMedia)).toEqual([
      [
        {
          path: "media/inbound/a.png",
          contentType: "image/png",
          workspaceDir: "/workspace",
        },
        {
          path: "media/inbound/b.pdf",
          contentType: "application/pdf",
          workspaceDir: "/workspace",
        },
      ],
      [
        {
          path: "media/inbound/a.png",
          contentType: "image/png",
          workspaceDir: "/workspace",
        },
        {
          path: "media/inbound/b.pdf",
          contentType: "application/pdf",
          workspaceDir: "/workspace",
        },
      ],
    ]);
  });

  it("preserves facts when an overflow source is rebuilt for retry", () => {
    const source = createQueueTestRun({
      prompt: "[media attached: /tmp/retry.png (image/png)]\nretry me",
    });
    source.media = [{ path: "/tmp/retry.png", contentType: "image/png" }];
    source.workspaceMedia = [
      {
        path: "media/inbound/retry.png",
        contentType: "image/png",
        workspaceDir: "/workspace",
      },
    ];

    const retry = createOverflowSummaryRetrySource(source);

    expect(retry.prompt).toBe(source.prompt);
    expect(retry.media).toEqual(source.media);
    expect(retry.workspaceMedia).toEqual(source.workspaceMedia);
  });

  it("preserves an explicit empty workspace carrier through collect batching", async () => {
    const key = `workspace-media-empty-${Date.now()}`;
    queueKeys.add(key);
    const settings: QueueSettings = { mode: "collect", debounceMs: 0 };
    const done = createDeferred<void>();
    const calls: FollowupRun[] = [];
    const first = createQueueTestRun({ prompt: "first" });
    first.media = [{ path: "/gateway/raw-alias.png", contentType: "image/png" }];
    first.workspaceMedia = [];
    const second = createQueueTestRun({ prompt: "second" });
    second.media = [{ path: "/gateway/other-alias.png", contentType: "image/png" }];
    second.workspaceMedia = [];
    enqueueFollowupRun(key, first, settings);
    enqueueFollowupRun(key, second, settings);

    scheduleFollowupDrain(key, async (run) => {
      calls.push(run);
      done.resolve();
    });
    await done.promise;

    expect(calls).toHaveLength(1);
    expect(calls[0]?.workspaceMedia).toEqual([]);
    expect(calls[0]?.media).toEqual([
      { path: "/gateway/raw-alias.png", contentType: "image/png" },
      { path: "/gateway/other-alias.png", contentType: "image/png" },
    ]);
  });

  it("uses legacy prompt media only for legacy items in a mixed collect batch", async () => {
    const key = `workspace-media-mixed-${Date.now()}`;
    queueKeys.add(key);
    const settings: QueueSettings = { mode: "collect", debounceMs: 0 };
    const done = createDeferred<void>();
    const calls: FollowupRun[] = [];
    const explicit = createQueueTestRun({ prompt: "explicit" });
    explicit.media = [{ path: "/gateway/explicit-alias.png", contentType: "image/png" }];
    explicit.workspaceMedia = [
      {
        path: "media/inbound/explicit.png",
        contentType: "image/png",
        workspaceDir: "/workspace",
      },
    ];
    const legacy = createQueueTestRun({ prompt: "legacy" });
    legacy.media = [{ path: "media/inbound/legacy.pdf", contentType: "application/pdf" }];
    enqueueFollowupRun(key, explicit, settings);
    enqueueFollowupRun(key, legacy, settings);

    scheduleFollowupDrain(key, async (run) => {
      calls.push(run);
      done.resolve();
    });
    await done.promise;

    expect(calls).toHaveLength(1);
    expect(calls[0]?.workspaceMedia).toEqual([
      {
        path: "media/inbound/explicit.png",
        contentType: "image/png",
        workspaceDir: "/workspace",
      },
      { path: "media/inbound/legacy.pdf", contentType: "application/pdf" },
    ]);
  });
});
