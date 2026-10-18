/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import "./logs-page.ts";

type TestLogsPage = HTMLElement & {
  context: ApplicationContext;
  connected: boolean;
  logsAutoFollow: boolean;
  logsEntries: unknown[];
  logsStatus: { error: string | null; hasLoaded: boolean; stale: boolean };
  streamFollow: {
    atBottom: boolean;
    schedule: (force?: boolean) => void;
  };
  readonly updateComplete: Promise<boolean>;
  applyGatewaySnapshot: (snapshot: ApplicationGatewaySnapshot) => void;
  loadLogs: (opts?: { reset?: boolean; quiet?: boolean }) => Promise<boolean>;
  requestUpdate: () => void;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function contextWithClient(
  client: GatewayBrowserClient,
  phase: ApplicationGatewaySnapshot["phase"] = "stopped",
): ApplicationContext {
  return {
    basePath: "",
    gateway: {
      snapshot: { client, phase },
      subscribe: () => () => undefined,
    },
    navigate: vi.fn(),
    preload: vi.fn(async () => undefined),
  } as unknown as ApplicationContext;
}

describe("LogsPage lifecycle", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("does not schedule scroll work after disconnect", async () => {
    const page = document.createElement("openclaw-logs-page") as TestLogsPage;
    page.context = {
      basePath: "",
      gateway: {
        snapshot: { client: null, phase: "stopped" },
        subscribe: () => () => undefined,
      },
      navigate: vi.fn(),
      preload: vi.fn(async () => undefined),
    } as unknown as ApplicationContext;
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);

    document.body.append(page);
    await page.updateComplete;
    await Promise.resolve();
    requestFrame.mockClear();

    page.streamFollow.schedule();
    page.remove();
    await Promise.resolve();

    expect(requestFrame).not.toHaveBeenCalled();
  });

  it("forces a scroll when auto-follow is re-enabled away from the bottom", async () => {
    const client = {
      request: vi.fn(
        () =>
          new Promise(() => {
            // Keep any incidental request pending; this test only exercises scroll state.
          }),
      ),
    } as unknown as GatewayBrowserClient;
    const page = document.createElement("openclaw-logs-page") as TestLogsPage;
    page.context = contextWithClient(client);
    document.body.append(page);
    await page.updateComplete;

    page.logsAutoFollow = false;
    await page.updateComplete;
    const scheduleScroll = vi.spyOn(page.streamFollow, "schedule");
    page.streamFollow.atBottom = false;
    page.logsAutoFollow = true;
    await page.updateComplete;

    expect(scheduleScroll).toHaveBeenCalledOnce();
    expect(scheduleScroll).toHaveBeenCalledWith(true);
  });

  it("discards a log response from a replaced gateway source that reuses its client", async () => {
    const pending = deferred<{ cursor: number; lines: string[]; reset: boolean }>();
    const client = {
      request: vi.fn(() => pending.promise),
    } as unknown as GatewayBrowserClient;
    const page = document.createElement("openclaw-logs-page") as TestLogsPage;
    page.context = contextWithClient(client);
    document.body.append(page);
    await page.updateComplete;
    page.connected = true;

    const load = page.loadLogs({ reset: true });
    page.context = contextWithClient(client);
    page.requestUpdate();
    await page.updateComplete;
    pending.resolve({ cursor: 1, lines: ["stale"], reset: true });
    await load;

    expect(page.logsEntries).toEqual([]);
  });

  it("discards a log response that completes after disconnect", async () => {
    const pending = deferred<{ cursor: number; lines: string[]; reset: boolean }>();
    const client = {
      request: vi.fn(() => pending.promise),
    } as unknown as GatewayBrowserClient;
    const page = document.createElement("openclaw-logs-page") as TestLogsPage;
    page.context = contextWithClient(client);
    document.body.append(page);
    await page.updateComplete;
    page.connected = true;

    const load = page.loadLogs({ reset: true });
    page.remove();
    pending.resolve({ cursor: 1, lines: ["stale"], reset: true });
    await load;

    expect(page.logsEntries).toEqual([]);
  });

  it("discards a log response when the gateway disconnects with the same client", async () => {
    const pending = deferred<{ cursor: number; lines: string[]; reset: boolean }>();
    const client = {
      request: vi.fn(() => pending.promise),
    } as unknown as GatewayBrowserClient;
    const page = document.createElement("openclaw-logs-page") as TestLogsPage;
    page.context = contextWithClient(client);
    document.body.append(page);
    await page.updateComplete;
    page.connected = true;

    const load = page.loadLogs({ reset: true });
    page.applyGatewaySnapshot({ client, phase: "stopped" } as ApplicationGatewaySnapshot);
    pending.resolve({ cursor: 1, lines: ["stale"], reset: true });
    await load;

    expect(page.logsEntries).toEqual([]);
  });

  it.each([200, 0])(
    "keeps the initial %s-line tail through same-connection metadata updates and appends from its cursor",
    async (initialCount) => {
      const initial = deferred<{ cursor: number; lines: string[]; reset: boolean }>();
      const lines = Array.from({ length: initialCount }, (_, index) => `line ${index + 1}`);
      const request = vi
        .fn((_method: string, _params: unknown, _options?: { signal?: AbortSignal }) =>
          Promise.resolve({ cursor: initialCount + 1, lines: ["appended"], reset: false }),
        )
        .mockReturnValueOnce(initial.promise);
      const client = { request } as unknown as GatewayBrowserClient;
      const page = document.createElement("openclaw-logs-page") as TestLogsPage;
      page.context = contextWithClient(client, "connected");
      document.body.append(page);
      await page.updateComplete;
      expect(request).toHaveBeenCalledTimes(1);
      const signal = request.mock.calls[0]?.[2]?.signal;
      expect(signal).toBeInstanceOf(AbortSignal);

      page.applyGatewaySnapshot({ ...page.context.gateway.snapshot, sessionKey: "other" });

      expect(request).toHaveBeenCalledTimes(1);
      expect(signal?.aborted).toBe(false);
      initial.resolve({ cursor: initialCount, lines, reset: true });
      await vi.waitFor(() => expect(page.logsStatus.hasLoaded).toBe(true));
      expect(page.logsEntries).toHaveLength(initialCount);
      page.applyGatewaySnapshot({ ...page.context.gateway.snapshot, sessionKey: "another" });
      expect(request).toHaveBeenCalledTimes(1);
      expect(signal?.aborted).toBe(false);

      await page.loadLogs({ quiet: true });

      expect(request).toHaveBeenCalledTimes(2);
      expect(request.mock.calls[1]?.[1]).toEqual({
        cursor: initialCount,
        limit: 500,
        maxBytes: 250_000,
      });
      expect(page.logsEntries).toHaveLength(initialCount + 1);
      expect(page.logsEntries.at(-1)).toEqual(expect.objectContaining({ raw: "appended" }));
      await page.updateComplete;
      expect(page.querySelectorAll(".log-row")).toHaveLength(initialCount + 1);
    },
  );

  it("lets an explicit reset replace a pending quiet poll without applying its late tail", async () => {
    const poll = deferred<{ cursor: number; lines: string[]; reset: boolean }>();
    const reset = deferred<{ cursor: number; lines: string[]; reset: boolean }>();
    const request = vi
      .fn((_method: string, _params: unknown, _options?: { signal?: AbortSignal }) =>
        Promise.resolve({ cursor: 200, lines: ["initial"], reset: true }),
      )
      .mockResolvedValueOnce({ cursor: 200, lines: ["initial"], reset: true })
      .mockReturnValueOnce(poll.promise)
      .mockReturnValueOnce(reset.promise);
    const client = { request } as unknown as GatewayBrowserClient;
    const page = document.createElement("openclaw-logs-page") as TestLogsPage;
    page.context = contextWithClient(client);
    document.body.append(page);
    await page.updateComplete;
    page.connected = true;
    await page.loadLogs({ reset: true });
    const quiet = page.loadLogs({ quiet: true });
    const signal = request.mock.calls[1]?.[2]?.signal;
    expect(signal?.aborted).toBe(false);

    const refresh = page.loadLogs({ reset: true });

    expect(request).toHaveBeenCalledTimes(3);
    expect(signal?.aborted).toBe(true);
    expect(request.mock.calls[1]?.[1]).toEqual({ cursor: 200, limit: 500, maxBytes: 250_000 });
    expect(request.mock.calls[2]?.[1]).toEqual({
      cursor: undefined,
      limit: 500,
      maxBytes: 250_000,
    });
    reset.resolve({ cursor: 300, lines: ["replacement"], reset: true });
    await refresh;
    poll.resolve({ cursor: 201, lines: ["stale tail"], reset: false });
    await quiet;
    expect(page.logsEntries).toEqual([expect.objectContaining({ raw: "replacement" })]);
  });

  it("serializes quiet polls so an older cursor cannot overwrite a newer one", async () => {
    const pending = deferred<{ cursor: number; lines: string[]; reset: boolean }>();
    const request = vi.fn(() => pending.promise);
    const client = {
      request,
    } as unknown as GatewayBrowserClient;
    const page = document.createElement("openclaw-logs-page") as TestLogsPage;
    page.context = contextWithClient(client);
    document.body.append(page);
    await page.updateComplete;
    page.connected = true;

    const first = page.loadLogs({ quiet: true });
    const second = page.loadLogs({ quiet: true });
    expect(request).toHaveBeenCalledTimes(1);
    expect(await second).toBe(false);

    pending.resolve({ cursor: 2, lines: ["fresh"], reset: true });
    expect(await first).toBe(true);
    expect(page.logsEntries).toHaveLength(1);
  });

  it("retains loaded logs as stale after failure and clears the marker on retry success", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ cursor: 1, lines: ["old"], reset: true })
      .mockRejectedValueOnce(new Error("logs unavailable"))
      .mockResolvedValueOnce({ cursor: 2, lines: ["fresh"], reset: true });
    const client = { request } as unknown as GatewayBrowserClient;
    const page = document.createElement("openclaw-logs-page") as TestLogsPage;
    page.context = contextWithClient(client);
    document.body.append(page);
    await page.updateComplete;
    page.connected = true;

    await page.loadLogs({ reset: true });
    await page.loadLogs({ reset: true });
    expect(page.logsEntries).toHaveLength(1);
    expect(page.logsStatus).toEqual({
      error: "Error: logs unavailable",
      hasLoaded: true,
      stale: true,
    });

    await page.loadLogs({ reset: true });
    expect(page.logsStatus).toEqual({ error: null, hasLoaded: true, stale: false });
    expect(page.logsEntries).toHaveLength(1);
  });

  it("drops deferred scroll work after a same-client reconnect", async () => {
    const client = {
      request: vi.fn(
        () =>
          new Promise(() => {
            // Keep both connection-epoch requests pending while scroll ownership changes.
          }),
      ),
    } as unknown as GatewayBrowserClient;
    const page = document.createElement("openclaw-logs-page") as TestLogsPage;
    page.context = contextWithClient(client);
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
    document.body.append(page);
    await page.updateComplete;
    page.applyGatewaySnapshot({ client, phase: "connected" } as ApplicationGatewaySnapshot);
    requestFrame.mockClear();

    page.streamFollow.schedule();
    page.applyGatewaySnapshot({ client, phase: "stopped" } as ApplicationGatewaySnapshot);
    page.applyGatewaySnapshot({ client, phase: "connected" } as ApplicationGatewaySnapshot);
    await Promise.resolve();

    expect(requestFrame).not.toHaveBeenCalled();
  });
});
