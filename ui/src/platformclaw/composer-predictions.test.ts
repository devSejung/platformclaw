import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ComposerPredictionController,
  updateComposerPreferences,
  recordWebComposerRun,
  webComposerRunSession,
} from "./composer-predictions.ts";

describe("Web composer predictions", () => {
  const fetchMock = vi.fn<typeof fetch>();
  let prediction: ComposerPredictionController;
  const source = {
    sessionKey: "agent:personal:main",
    completedRunId: "run-1",
    idle: true,
    eligible: true,
  };
  const requestBody = (options?: RequestInit) => {
    if (typeof options?.body !== "string") {
      throw new Error("Expected a JSON string request body");
    }
    return JSON.parse(options.body) as { action: string; enabled?: boolean };
  };
  beforeEach(async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async (_url, options) => {
      const body = requestBody(options);
      return Response.json(
        body.action === "preferences"
          ? { available: true, enabled: body.enabled ?? true }
          : { text: "구체적인 실행 방법을 알려줘" },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    prediction = new ComposerPredictionController(vi.fn());
    await updateComposerPreferences(true);
  });
  afterEach(() => {
    prediction.dispose();
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  const predictCalls = () =>
    fetchMock.mock.calls.filter(([, options]) => requestBody(options).action === "predict");
  it("waits one second, predicts once per completion, and only takes explicit text", async () => {
    prediction.sync(source);
    await vi.advanceTimersByTimeAsync(999);
    expect(predictCalls()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(prediction.text).toBe("구체적인 실행 방법을 알려줘");
    expect(prediction.take()).toBe("구체적인 실행 방법을 알려줘");
    expect(prediction.text).toBeNull();
    prediction.sync(source);
    await vi.advanceTimersByTimeAsync(2000);
    expect(predictCalls()).toHaveLength(1);
  });
  it.each(["typing", "session", "run", "off"])(
    "discards a late response after %s",
    async (reason) => {
      let resolve!: (response: Response) => void;
      fetchMock.mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      prediction.sync(source);
      await vi.advanceTimersByTimeAsync(1000);
      const signal = predictCalls()[0]?.[1]?.signal;
      if (reason === "typing") {
        prediction.sync({ ...source, eligible: false });
      }
      if (reason === "session") {
        prediction.sync({ ...source, sessionKey: "agent:personal:other", completedRunId: null });
      }
      if (reason === "run") {
        prediction.sync({ ...source, idle: false, completedRunId: null });
      }
      if (reason === "off") {
        await updateComposerPreferences(false);
      }
      expect(signal?.aborted).toBe(true);
      resolve(Response.json({ text: "stale" }));
      await vi.advanceTimersByTimeAsync(0);
      expect(prediction.text).toBeNull();
    },
  );
  it("makes no prediction request while disabled", async () => {
    await updateComposerPreferences(false);
    prediction.sync(source);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(predictCalls()).toHaveLength(0);
  });
  it("retains a completed anchor until the composer becomes idle", async () => {
    prediction.sync({ ...source, idle: false });
    prediction.sync(source);
    await vi.advanceTimersByTimeAsync(1000);
    expect(prediction.text).not.toBeNull();
  });
  it("requires a browser dispatch fact and isolates its client and run identity", () => {
    const client = {};
    expect(webComposerRunSession(client, "cron-run")).toBeUndefined();
    recordWebComposerRun(client, source.sessionKey, "web-run");
    expect(webComposerRunSession(client, "web-run")).toBe(source.sessionKey);
    expect(webComposerRunSession({}, "web-run")).toBeUndefined();
    expect(webComposerRunSession(client, "knox-run")).toBeUndefined();
    for (let index = 0; index < 64; index++) {
      recordWebComposerRun(client, source.sessionKey, `web-${index}`);
    }
    expect(webComposerRunSession(client, "web-run")).toBeUndefined();
  });
});
