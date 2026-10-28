const PATH = "/platformclaw/api/composer-predictions";
const webRuns = new WeakMap<object, Map<string, string>>();

// Record provenance at browser dispatch, rather than inferring it from a shared final event.
// A Cron/Knox/background final can otherwise adopt the visible chat's run status.
export function recordWebComposerRun(client: object, sessionKey: string, runId: string): void {
  let runs = webRuns.get(client);
  if (!runs) {
    runs = new Map();
    webRuns.set(client, runs);
  }
  runs.set(runId, sessionKey);
  if (runs.size > 64) {
    const oldest = runs.keys().next().value;
    if (oldest !== undefined) {
      runs.delete(oldest);
    }
  }
}

export function webComposerRunSession(client: object, runId: string): string | undefined {
  return webRuns.get(client)?.get(runId);
}
type PredictionPreferences = { available: boolean; enabled: boolean };
const listeners = new Set<() => void>();
let preferences: PredictionPreferences = { available: false, enabled: false };

export function composerPredictionsAvailable(): PredictionPreferences {
  return preferences;
}

export async function updateComposerPreferences(enabled?: boolean): Promise<void> {
  try {
    const response = await fetch(PATH, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        action: "preferences",
        ...(enabled === undefined ? {} : { enabled }),
      }),
    });
    const result: unknown = await response.json();
    preferences =
      response.ok &&
      result !== null &&
      typeof result === "object" &&
      "available" in result &&
      result.available === true &&
      "enabled" in result
        ? { available: true, enabled: result.enabled === true }
        : { available: false, enabled: false };
  } catch {
    preferences = { available: false, enabled: false };
  }
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeComposerPreferences(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

type PredictionSource = {
  sessionKey: string;
  completedRunId: string | null;
  idle: boolean;
  eligible: boolean;
};

/** Port of upstream's presentation-only prediction lifecycle for the Lit composer. */
export class ComposerPredictionController {
  text: string | null = null;
  private source: PredictionSource | null = null;
  private lastRunId: string | null = null;
  private request: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly unsubscribe: () => void;

  constructor(private readonly requestUpdate: () => void) {
    this.unsubscribe = subscribeComposerPreferences(() => {
      if (!preferences.available || !preferences.enabled) {
        this.dismiss();
      }
      this.requestUpdate();
    });
    void updateComposerPreferences();
  }

  sync(next: PredictionSource): void {
    const scopeChanged = this.source?.sessionKey !== next.sessionKey;
    if (scopeChanged) {
      this.dismiss();
      this.lastRunId = null;
    }
    this.source = next;
    if (!next.eligible || !preferences.available || !preferences.enabled) {
      this.dismiss();
      // Typing consumes this completion even if the user later clears the draft.
      this.lastRunId = next.completedRunId;
      return;
    }
    // A final event can precede the idle render. Do not consume its completion anchor yet.
    if (!next.idle) {
      this.dismiss();
      return;
    }
    if (!next.completedRunId || this.lastRunId === next.completedRunId) {
      return;
    }
    this.lastRunId = next.completedRunId;
    this.dismiss();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.predict(next);
    }, 1000);
  }

  dismiss(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.request?.abort();
    this.request = null;
    this.text = null;
  }

  take(): string | null {
    const text =
      this.source?.eligible && this.source.idle && preferences.enabled ? this.text : null;
    this.dismiss();
    return text;
  }

  dispose(): void {
    this.dismiss();
    this.unsubscribe();
  }

  private async predict(origin: PredictionSource): Promise<void> {
    const pending = new AbortController();
    this.request = pending;
    const signal = AbortSignal.any([pending.signal, AbortSignal.timeout(10_000)]);
    try {
      const response = await fetch(PATH, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        signal,
        body: JSON.stringify({ action: "predict", sessionKey: origin.sessionKey }),
      });
      const result: unknown = await response.json();
      if (
        this.request !== pending ||
        signal.aborted ||
        this.source?.sessionKey !== origin.sessionKey ||
        !this.source.idle ||
        !this.source.eligible ||
        !preferences.enabled
      ) {
        return;
      }
      this.text =
        response.ok &&
        result !== null &&
        typeof result === "object" &&
        "text" in result &&
        typeof result.text === "string" &&
        result.text.length <= 300
          ? result.text.trim() || null
          : null;
      this.requestUpdate();
    } catch {
      // Speculative work is silent and never interrupts normal chat.
    } finally {
      if (this.request === pending) {
        this.request = null;
      }
    }
  }
}
