import { vi } from "vitest";

export function waitForSkillWorkshop(assertion: () => void) {
  return vi.waitFor(assertion, { interval: 1 });
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

export function callsFor(request: ReturnType<typeof vi.fn>, method: string) {
  return request.mock.calls.filter(([calledMethod]) => calledMethod === method);
}

export function createRuntimeConfigStub(options?: {
  sourceConfig?: Record<string, unknown>;
  patch?: ReturnType<typeof vi.fn>;
}) {
  return {
    state: {
      configSnapshot: options?.sourceConfig
        ? { hash: "hash-1", sourceConfig: options.sourceConfig }
        : null,
      configLoading: false,
      lastError: null as string | null,
    },
    ensureLoaded: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
    patch: options?.patch ?? vi.fn(async () => true),
    subscribe: () => () => undefined,
  };
}
