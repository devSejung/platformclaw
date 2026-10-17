import type {
  AnnouncementSnapshot,
  WebAnnouncement,
} from "../../../packages/platformclaw-control-plane/src/announcement-contracts.js";

/** Revisions protect content; request order protects same-revision clock samples. */
export class AnnouncementState {
  snapshot: AnnouncementSnapshot | null = null;
  private sequence = -1;
  private sampledAt = 0;
  private serverTime = 0;

  accept(
    snapshot: AnnouncementSnapshot,
    sequence: number,
    startedAt: number,
    receivedAt: number,
  ): boolean {
    if (
      !Number.isSafeInteger(snapshot.revision) ||
      !Number.isFinite(snapshot.serverNow) ||
      snapshot.revision < (this.snapshot?.revision ?? -1) ||
      (snapshot.revision === this.snapshot?.revision && sequence < this.sequence)
    ) {
      return false;
    }
    this.snapshot = snapshot;
    this.sequence = sequence;
    this.sampledAt = receivedAt;
    // Midpoint estimate includes half the round-trip latency; wall-clock changes
    // on the user's computer cannot move the countdown after this sample.
    this.serverTime = snapshot.serverNow + Math.max(0, receivedAt - startedAt) / 2;
    return true;
  }

  now(monotonicNow: number): number {
    return this.serverTime + Math.max(0, monotonicNow - this.sampledAt);
  }

  active(monotonicNow: number): WebAnnouncement | null {
    const notice = this.snapshot?.announcement;
    return notice && notice.expiresAt > this.now(monotonicNow) ? notice : null;
  }
}
