import { describe, expect, it, vi } from "vitest";
import { SkillsChangedRefreshQueue, skillsPageAllowedHubTabs } from "./skills-page.ts";

describe("Skills page plugin hub navigation", () => {
  it("keeps Workshop discoverable for personal agents on every execution target", () => {
    expect(skillsPageAllowedHubTabs("personal-agent")).toEqual(["skills", "workshop"]);
  });

  it("keeps the complete plugin hub for administrators", () => {
    expect(skillsPageAllowedHubTabs(undefined)).toBeUndefined();
  });
});

describe("SkillsChangedRefreshQueue", () => {
  it("ignores invalidation before the initial status load", () => {
    const refresh = vi.fn(async () => undefined);
    const queue = new SkillsChangedRefreshQueue(() => true, refresh);

    queue.invalidate(false);

    expect(refresh).not.toHaveBeenCalled();
  });

  it("queues one forced refresh behind an active status load", async () => {
    let available = false;
    let resolveRefresh!: () => void;
    const refresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    const queue = new SkillsChangedRefreshQueue(() => available, refresh);

    queue.invalidate(true);
    queue.invalidate(true);
    expect(refresh).not.toHaveBeenCalled();

    available = true;
    queue.drain();
    expect(refresh).toHaveBeenCalledTimes(1);
    queue.invalidate(true);
    expect(refresh).toHaveBeenCalledTimes(1);

    resolveRefresh();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
  });

  it("drops queued invalidation when the gateway source resets", () => {
    let available = false;
    const refresh = vi.fn(async () => undefined);
    const queue = new SkillsChangedRefreshQueue(() => available, refresh);
    queue.invalidate(true);

    queue.reset();
    available = true;
    queue.drain();

    expect(refresh).not.toHaveBeenCalled();
  });
});
