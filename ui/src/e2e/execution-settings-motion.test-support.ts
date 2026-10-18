import type { Locator } from "playwright";
import { expect } from "vitest";

export async function assertExecutionTransfer(
  component: Locator,
  target: "assigned_vm" | "platform_server",
  reducedMotion: boolean,
  labels: { basic: string; vm: string },
) {
  const panel = component.locator("[data-progress-panel][data-phase='switching']");
  await panel.waitFor();
  const proof = await panel.evaluate(async (element) => {
    const host = element.getRootNode() as ShadowRoot;
    const owner = host.host as HTMLElement & { executionEndpointProof?: Element[] };
    const endpoints = Array.from(element.querySelectorAll("[data-endpoint]"));
    const stable =
      !owner.executionEndpointProof ||
      endpoints.every((node, index) => node === owner.executionEndpointProof![index]);
    owner.executionEndpointProof ??= endpoints;
    const [left, right] = endpoints;
    if (endpoints.length !== 2 || !left || !right) {
      throw new Error("Work-location motion requires exactly two endpoints");
    }
    const transfer = element.querySelector<HTMLElement>(".execution-transfer")!;
    const marker = transfer.querySelector("span")!;
    const animations = transfer.getAnimations();
    const animation = animations[0];
    let positions: number[] = [];
    let running = false;
    let autoplay = false;
    if (animation) {
      autoplay = animation.playState === "running" || animation.playState === "finished";
      // Render real CSS interpolation at two frames without racing a short one-shot animation.
      animation.pause();
      animation.currentTime = 0;
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
      positions.push(marker.getBoundingClientRect().x);
      animation.currentTime = Number(animation.effect!.getTiming().duration) / 2;
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
      positions.push(marker.getBoundingClientRect().x);
      animation.currentTime = 0;
      animation.play();
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
      running = animation.playState === "running";
      animation.finish();
    } else {
      positions = [marker.getBoundingClientRect().x];
    }
    return {
      ids: endpoints.map((node) => node.getAttribute("data-endpoint")),
      labels: endpoints.map((node) => node.textContent?.trim()),
      fixedOrder: left.getBoundingClientRect().right < right.getBoundingClientRect().left,
      stable,
      direction: element.querySelector("[data-direction]")?.getAttribute("data-direction"),
      destination: element.querySelector(".execution-destination")?.getAttribute("data-endpoint"),
      destinationAnimating: element
        .querySelector(".execution-destination > svg")!
        .getAnimations()
        .some((effect) => effect.playState === "running"),
      visible:
        marker.getBoundingClientRect().width > 0 && getComputedStyle(transfer).display !== "none",
      ongoing: element
        .getAnimations({ subtree: true })
        .filter((effect) => effect.playState === "running" || effect.pending).length,
      positions,
      autoplay,
      running,
    };
  });
  expect(proof.ids).toEqual(["platform_server", "assigned_vm"]);
  expect(proof.labels).toEqual([labels.basic, labels.vm]);
  expect(proof.fixedOrder).toBe(true);
  expect(proof.stable).toBe(true);
  expect(proof.direction).toBe(target);
  expect(proof.destination).toBe(target);
  expect(proof.destinationAnimating).toBe(!reducedMotion);
  expect(proof.visible).toBe(true);
  if (reducedMotion) {
    expect(proof.ongoing).toBe(0);
    expect(proof.positions).toHaveLength(1);
  } else {
    expect(proof.autoplay).toBe(true);
    expect(proof.running).toBe(true);
    expect(proof.positions).toHaveLength(2);
    const distance = proof.positions[1]! - proof.positions[0]!;
    expect(target === "assigned_vm" ? distance : -distance).toBeGreaterThan(4);
  }
}
