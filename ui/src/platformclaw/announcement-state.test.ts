import { describe, expect, it, vi } from "vitest";
import type { AnnouncementSnapshot } from "../../../packages/platformclaw-control-plane/src/announcement-contracts.js";
import { AnnouncementState } from "./announcement-state.ts";

function snapshot(revision = 1): AnnouncementSnapshot {
  return {
    revision,
    serverNow: 10_000,
    announcement: {
      id: "notice",
      revision,
      title: "Notice",
      body: "Plain text",
      kind: "maintenance",
      maintenanceAt: 12_000,
      expiresAt: 15_000,
    },
  };
}

describe("announcement revision and server clock", () => {
  it("rejects reversed responses and duplicate older samples after modification or cancellation", () => {
    const state = new AnnouncementState();
    state.accept(snapshot(2), 2, 100, 200);
    expect(state.accept(snapshot(1), 1, 0, 300)).toBe(false);
    expect(state.accept(snapshot(2), 1, 0, 300)).toBe(false);
    expect(state.snapshot?.revision).toBe(2);
    state.accept({ ...snapshot(3), announcement: null }, 3, 300, 400);
    expect(state.accept(snapshot(2), 4, 400, 500)).toBe(false);
    expect(state.active(500)).toBeNull();
  });

  it("uses a monotonic countdown with half-RTT correction, ignoring the client wall clock, and expires locally", () => {
    const state = new AnnouncementState();
    state.accept(snapshot(), 1, 100, 300);
    const wall = vi.spyOn(Date, "now").mockReturnValue(99_999_999_999_999);
    try {
      expect(state.now(1_300)).toBe(11_100);
      expect(state.active(5_199)).not.toBeNull();
      expect(state.active(5_200)).toBeNull();
    } finally {
      wall.mockRestore();
    }
  });
});
