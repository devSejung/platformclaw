import { describe, expect, it, vi } from "vitest";
import { BrowserGatewayObserverVisibility } from "./browser-gateway-observer-visibility.js";

function setup() {
  const request = vi.fn(async () => undefined);
  const visibility = new BrowserGatewayObserverVisibility({ request }, () =>
    Object.assign(new Error("connection is no longer active"), { code: "invalid-params" }),
  );
  return { request, visibility };
}

describe("BrowserGatewayObserverVisibility", () => {
  it("aggregates visibility across browser connections", async () => {
    const { request, visibility } = setup();
    visibility.registerConnection("browser-1");
    visibility.registerConnection("browser-2");

    await expect(visibility.setConnectionVisibility("browser-1", true)).resolves.toEqual({
      ok: true,
    });
    await expect(visibility.setConnectionVisibility("browser-2", true)).resolves.toEqual({
      ok: true,
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("sessions.observer.visibility", { visible: true });

    await visibility.releaseConnection("browser-1");
    expect(request).toHaveBeenCalledTimes(1);
    await visibility.releaseConnection("browser-2");
    expect(request).toHaveBeenLastCalledWith("sessions.observer.visibility", { visible: false });
  });

  it("retries a failed first visibility declaration", async () => {
    const { request, visibility } = setup();
    visibility.registerConnection("browser-1");
    request.mockRejectedValueOnce(new Error("temporary Gateway failure"));

    await expect(visibility.setConnectionVisibility("browser-1", true)).rejects.toThrow(
      "temporary Gateway failure",
    );
    await expect(visibility.setConnectionVisibility("browser-1", true)).resolves.toEqual({
      ok: true,
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not restore visibility after a connection closes", async () => {
    const { request, visibility } = setup();
    visibility.registerConnection("browser-1");
    await visibility.releaseConnection("browser-1");

    await expect(visibility.setConnectionVisibility("browser-1", true)).rejects.toMatchObject({
      code: "invalid-params",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("retries a failed final visibility removal", async () => {
    const { request, visibility } = setup();
    visibility.registerConnection("browser-1");
    await visibility.setConnectionVisibility("browser-1", true);
    request.mockRejectedValueOnce(new Error("temporary Gateway failure"));

    await expect(visibility.setConnectionVisibility("browser-1", false)).rejects.toThrow(
      "temporary Gateway failure",
    );
    await expect(visibility.setConnectionVisibility("browser-1", false)).resolves.toEqual({
      ok: true,
    });
    expect(request.mock.calls).toEqual([
      ["sessions.observer.visibility", { visible: true }],
      ["sessions.observer.visibility", { visible: false }],
      ["sessions.observer.visibility", { visible: false }],
    ]);
  });

  it("reconciles a failed visibility removal after the last tab closes", async () => {
    vi.useFakeTimers();
    try {
      const { request, visibility } = setup();
      visibility.registerConnection("browser-1");
      await visibility.setConnectionVisibility("browser-1", true);
      request.mockRejectedValueOnce(new Error("temporary Gateway failure"));

      await visibility.releaseConnection("browser-1");
      await vi.advanceTimersByTimeAsync(250);
      expect(request.mock.calls).toEqual([
        ["sessions.observer.visibility", { visible: true }],
        ["sessions.observer.visibility", { visible: false }],
        ["sessions.observer.visibility", { visible: false }],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes a closed tab before an already-queued visibility retry runs", async () => {
    vi.useFakeTimers();
    try {
      const { request, visibility } = setup();
      visibility.registerConnection("browser-1");
      request.mockRejectedValueOnce(new Error("temporary Gateway failure"));
      await expect(visibility.setConnectionVisibility("browser-1", true)).rejects.toThrow(
        "temporary Gateway failure",
      );

      vi.advanceTimersByTime(250);
      await visibility.releaseConnection("browser-1");
      await vi.runAllTimersAsync();
      expect(request.mock.calls).toEqual([
        ["sessions.observer.visibility", { visible: true }],
        ["sessions.observer.visibility", { visible: false }],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("redeclares visibility after the private Gateway reconnects", async () => {
    const { request, visibility } = setup();
    visibility.registerConnection("browser-1");
    await visibility.setConnectionVisibility("browser-1", true);

    visibility.handleGatewayDisconnect();
    visibility.registerConnection("browser-2");
    await visibility.setConnectionVisibility("browser-2", true);
    expect(request.mock.calls).toEqual([
      ["sessions.observer.visibility", { visible: true }],
      ["sessions.observer.visibility", { visible: true }],
    ]);
  });
});
