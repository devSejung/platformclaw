import type { SpaceMember } from "../../../packages/platformclaw-control-plane/src/space-contracts.js";
import { spaceGatewayErrorMessage } from "./space-gateway-request.ts";

export type SpacePerson = Omit<SpaceMember, "role">;

/** One member-picker query generation; callers clear it when its authority changes. */
export class SpacePeopleSearch {
  query = "";
  candidates: SpacePerson[] = [];
  loading = false;
  searched = false;
  error = "";
  activeIndex = -1;
  private epoch = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly changed: () => void) {}

  clear() {
    this.epoch++;
    clearTimeout(this.timer);
    this.query = "";
    this.candidates = [];
    this.loading = false;
    this.searched = false;
    this.error = "";
    this.activeIndex = -1;
  }

  compose(query: string) {
    this.clear();
    this.query = query;
    this.changed();
  }

  search(query: string, request: (query: string) => Promise<SpacePerson[]>, immediate = false) {
    // Invalidate immediately, before debounce: old responses must never repopulate new queries.
    this.clear();
    this.query = query;
    this.changed();
    if (!query.trim()) {
      return;
    }
    const epoch = this.epoch;
    this.timer = setTimeout(
      () => void this.load(query.trim(), request, epoch),
      immediate ? 0 : 250,
    );
  }

  private async load(
    query: string,
    request: (query: string) => Promise<SpacePerson[]>,
    epoch: number,
  ) {
    this.loading = true;
    this.changed();
    try {
      const candidates = await request(query);
      if (epoch === this.epoch) {
        this.candidates = candidates;
        this.searched = true;
      }
    } catch (error) {
      if (epoch === this.epoch) {
        this.error = spaceGatewayErrorMessage(error);
      }
    } finally {
      if (epoch === this.epoch) {
        this.loading = false;
        this.changed();
      }
    }
  }

  move(direction: number) {
    const count = this.candidates.length;
    this.activeIndex = count
      ? this.activeIndex < 0
        ? direction > 0
          ? 0
          : count - 1
        : (this.activeIndex + direction + count) % count
      : -1;
    this.changed();
  }
}
