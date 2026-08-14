import { describe, expect, it } from "vitest";
import { PlatformClawTargetMutationCoordinator } from "./target-mutation-coordinator.js";

describe("PlatformClaw target mutation coordinator", () => {
  it("conflicts for the same Agent while allowing different Agents", () => {
    const coordinator = new PlatformClawTargetMutationCoordinator();
    const releaseOne = coordinator.tryAcquire("agent-one", "skill-install");

    expect(releaseOne).not.toBeNull();
    expect(coordinator.tryAcquire("agent-one", "target-change")).toBeNull();
    const releaseTwo = coordinator.tryAcquire("agent-two", "target-change");
    expect(releaseTwo).not.toBeNull();
    expect(coordinator.isHeld("agent-one", "target-change")).toBe(false);
    expect(coordinator.isHeld("agent-two", "target-change")).toBe(true);

    releaseOne?.();
    const releaseOneAgain = coordinator.tryAcquire("agent-one", "target-change");
    expect(releaseOneAgain).not.toBeNull();
    releaseOneAgain?.();
    releaseTwo?.();
  });
});
