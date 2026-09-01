// Loaded after hello so capability renewal does not inflate the startup chunk.
import { resolveSafeTimeoutDelayMs } from "@openclaw/gateway-client/browser";
import { normalizeCanvasRelaySurfaceUrl } from "../lib/canvas-surface-route.ts";

const RENEWAL_LEAD_MS = 15_000;
const MIN_RENEWAL_DELAY_MS = 1_000;
// Used only when a refresh response omits expiry; an early one-minute refresh
// is safe because it asks the server to rotate rather than extending authority.
const MISSING_EXPIRY_RENEWAL_DELAY_MS = 60_000;
const RETRY_START_MS = 1_000;
// Stay well below the server capability lifetime while limiting unsupported
// gateways to one cheap refresh request per five minutes per tab.
const RETRY_MAX_MS = 5 * 60_000;

type CanvasSurfaceRefresh = {
  surface: "canvas";
  canvasUrl: string;
  expiresAtMs?: number;
};

type CanvasSurfaceLease = {
  recover: (observedUrl: string) => Promise<string | null>;
  start: (helloUrl: string | undefined) => void;
  stop: () => void;
};

export function createCanvasSurfaceLease<
  TimerHandle = ReturnType<typeof globalThis.setTimeout>,
>(params: {
  request: (method: string, params: unknown) => Promise<unknown>;
  onChange: (url: string | null) => void;
  onConnectionChange?: () => void;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
}): CanvasSurfaceLease {
  const now = params.now ?? Date.now;
  const setTimer =
    params.setTimer ??
    ((callback: () => void, delayMs: number) =>
      globalThis.setTimeout(callback, delayMs) as TimerHandle);
  const clearTimer =
    params.clearTimer ??
    ((timer: TimerHandle) =>
      globalThis.clearTimeout(timer as ReturnType<typeof globalThis.setTimeout>));
  let currentUrl: string | null = null;
  let timer: TimerHandle | null = null;
  let inFlight: { generation: number; promise: Promise<string | null> } | null = null;
  let consecutiveFailures = 0;
  let generation = 0;
  let started = false;
  const ownsGeneration = (expected: number) => started && generation === expected;

  const clearScheduledRenewal = () => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  };

  const schedule = (delayMs: number, expectedGeneration: number) => {
    if (!ownsGeneration(expectedGeneration)) {
      return;
    }
    clearScheduledRenewal();
    timer = setTimer(
      () => {
        if (!ownsGeneration(expectedGeneration)) {
          return;
        }
        timer = null;
        renew(expectedGeneration);
      },
      resolveSafeTimeoutDelayMs(delayMs, { minMs: MIN_RENEWAL_DELAY_MS }),
    );
  };

  const handleFailure = (expectedGeneration: number) => {
    if (!ownsGeneration(expectedGeneration)) {
      return;
    }
    consecutiveFailures += 1;
    const retryDelayMs = Math.min(RETRY_START_MS * 2 ** (consecutiveFailures - 1), RETRY_MAX_MS);
    schedule(retryDelayMs, expectedGeneration);
  };

  const rotate = (expectedGeneration: number, observedUrl: string): Promise<string | null> => {
    if (!ownsGeneration(expectedGeneration) || !currentUrl) {
      return Promise.resolve(null);
    }
    // A proactive renewal may have already replaced the URL that failed in a
    // mounted frame. Reuse it instead of rotating the current authority again.
    if (currentUrl !== observedUrl) {
      return Promise.resolve(currentUrl);
    }
    if (inFlight?.generation === expectedGeneration) {
      return inFlight.promise;
    }
    const request = Promise.resolve()
      .then(() => params.request("plugin.surface.refresh", { surface: "canvas", observedUrl }))
      .then((response) => {
        if (!ownsGeneration(expectedGeneration)) {
          return null;
        }
        if (currentUrl !== observedUrl) {
          return currentUrl;
        }
        const refreshed = parseCanvasSurfaceRefresh(response);
        if (!refreshed) {
          handleFailure(expectedGeneration);
          return null;
        }
        consecutiveFailures = 0;
        currentUrl = refreshed.canvasUrl;
        params.onChange(currentUrl);
        const delayMs =
          refreshed.expiresAtMs === undefined
            ? MISSING_EXPIRY_RENEWAL_DELAY_MS
            : Math.max(MIN_RENEWAL_DELAY_MS, refreshed.expiresAtMs - now() - RENEWAL_LEAD_MS);
        schedule(delayMs, expectedGeneration);
        return currentUrl;
      })
      .catch(() => {
        handleFailure(expectedGeneration);
        return null;
      })
      .finally(() => {
        if (inFlight?.promise === request) {
          inFlight = null;
        }
      });
    inFlight = { generation: expectedGeneration, promise: request };
    return request;
  };

  const renew = (expectedGeneration: number) => {
    if (!ownsGeneration(expectedGeneration) || !currentUrl) {
      return;
    }
    void rotate(expectedGeneration, currentUrl);
  };

  return {
    recover(observedUrl) {
      const observed = normalizeCanvasRelaySurfaceUrl(observedUrl);
      if (!observed || !started || !currentUrl) {
        return Promise.resolve(null);
      }
      return rotate(generation, observed);
    },
    start(helloUrl) {
      generation += 1;
      started = true;
      consecutiveFailures = 0;
      clearScheduledRenewal();
      params.onConnectionChange?.();
      currentUrl = normalizeCanvasRelaySurfaceUrl(helloUrl);
      params.onChange(currentUrl);
      if (currentUrl) {
        renew(generation);
      }
    },
    stop() {
      if (!started && currentUrl === null && timer === null) {
        return;
      }
      generation += 1;
      started = false;
      consecutiveFailures = 0;
      clearScheduledRenewal();
      params.onConnectionChange?.();
      currentUrl = null;
      params.onChange(null);
    },
  };
}

function parseCanvasSurfaceRefresh(value: unknown): CanvasSurfaceRefresh | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const response = value as {
    surface?: unknown;
    pluginSurfaceUrls?: unknown;
    expiresAtMs?: unknown;
  };
  if (response.surface !== "canvas") {
    return undefined;
  }
  const urls = response.pluginSurfaceUrls;
  if (!urls || typeof urls !== "object" || Array.isArray(urls)) {
    return undefined;
  }
  const rawCanvasUrl = (urls as Record<string, unknown>).canvas;
  const canvasUrl =
    typeof rawCanvasUrl === "string" ? normalizeCanvasRelaySurfaceUrl(rawCanvasUrl) : null;
  if (!canvasUrl) {
    return undefined;
  }
  const expiresAtMs = response.expiresAtMs;
  if (
    expiresAtMs !== undefined &&
    (typeof expiresAtMs !== "number" || !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= 0)
  ) {
    return undefined;
  }
  return {
    surface: "canvas",
    canvasUrl,
    ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
  };
}
