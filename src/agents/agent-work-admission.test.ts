import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
import { createDeferred } from "../shared/deferred.js";
import {
  beginAgentWorkAdmission,
  hasPendingAgentWork,
  tryAcquireAgentWorkMutation,
  withAgentWorkAdmission,
} from "./agent-work-admission.js";

describe("agent work admission", () => {
  it("fences synchronously and excludes both new work and competing mutations", () => {
    const release = tryAcquireAgentWorkMutation("fenced-owner");
    expect(release).not.toBeNull();
    try {
      expect(() => beginAgentWorkAdmission("fenced-owner")).toThrow("Retry when it completes");
      expect(tryAcquireAgentWorkMutation("fenced-owner")).toBeNull();
      const releaseOther = beginAgentWorkAdmission("other-owner");
      releaseOther();
    } finally {
      release?.();
    }
    const releaseWork = beginAgentWorkAdmission("fenced-owner");
    releaseWork();
  });

  it("retains nested owner claims until every lifetime ends and release is idempotent", () => {
    const first = beginAgentWorkAdmission("nested-owner");
    const second = beginAgentWorkAdmission("NESTED-OWNER");
    first();
    first();
    expect(hasPendingAgentWork("nested-owner")).toBe(true);
    expect(tryAcquireAgentWorkMutation("nested-owner")).toBeNull();
    second();
    expect(hasPendingAgentWork("nested-owner")).toBe(false);
    const fence = tryAcquireAgentWorkMutation("nested-owner");
    expect(fence).not.toBeNull();
    fence?.();
  });

  it("holds through awaits and releases synchronous and asynchronous failures", async () => {
    const pending = createDeferred();
    const work = withAgentWorkAdmission("await-owner", async () => await pending.promise);
    expect(hasPendingAgentWork("await-owner")).toBe(true);
    expect(tryAcquireAgentWorkMutation("await-owner")).toBeNull();
    pending.resolve();
    await work;
    await expect(
      withAgentWorkAdmission("await-owner", () => {
        throw new Error("sync");
      }),
    ).rejects.toThrow("sync");
    await expect(
      withAgentWorkAdmission("await-owner", async () => {
        throw new Error("async");
      }),
    ).rejects.toThrow("async");
    expect(hasPendingAgentWork("await-owner")).toBe(false);
  });

  it("shares owner state with independently loaded runtime chunks", async () => {
    const other = await importFreshModule<typeof import("./agent-work-admission.js")>(
      import.meta.url,
      "./agent-work-admission.js?scope=other-chunk",
    );
    const release = beginAgentWorkAdmission("chunk-owner");
    try {
      expect(other.hasPendingAgentWork("chunk-owner")).toBe(true);
      expect(other.tryAcquireAgentWorkMutation("chunk-owner")).toBeNull();
    } finally {
      release();
    }
  });
});
