import "./undici-global-dispatcher.js";

export function resetGlobalUndiciStreamTimeoutsForTests(): void {
  const testing = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.undiciDispatcherTestApi")
  ] as { reset(): void };
  testing.reset();
}
