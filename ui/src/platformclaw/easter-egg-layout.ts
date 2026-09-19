import { BASEBALL_WORLD } from "./easter-egg-simulation.ts";

const BASELINE_OFFSET_PX = 138;

export type BaseballFieldLayout = {
  originX: number;
  groundY: number;
  height: number;
  pitchScale: number;
  scale: number;
  uiLeft: number;
  width: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function resolveBaseballFieldLayout(
  host: HTMLElement,
  arena: HTMLElement | null,
): BaseballFieldLayout {
  const width = arena?.clientWidth || window.innerWidth || 640;
  const height = arena?.clientHeight || window.innerHeight || 800;
  const navWidth = Number.parseFloat(getComputedStyle(host).getPropertyValue("--shell-nav-width"));
  const contentLeft = Number.isFinite(navWidth) ? navWidth : 0;
  const quickActions = document.querySelector<HTMLElement>("platformclaw-quick-actions");
  const accessoryBounds = quickActions
    ?.closest<HTMLElement>(".sidebar-account-footer__accessory")
    ?.getBoundingClientRect();
  const originX = clamp(contentLeft * (58 / 258), 48, 58);
  const scale = Math.max(2.4, (width - originX - 24) / (BASEBALL_WORLD.fenceX + 4));
  const pitcherX = contentLeft > 0 ? contentLeft - 38 : originX + 92;
  return {
    originX,
    groundY: Math.min(height - BASELINE_OFFSET_PX, (accessoryBounds?.top ?? height) - 8),
    height,
    pitchScale: (pitcherX - originX) / BASEBALL_WORLD.pitcherX,
    scale,
    uiLeft: contentLeft + 24,
    width,
  };
}

export function baseballWorldScreenX(
  x: number,
  layout: BaseballFieldLayout,
  pitchProjection = false,
): number {
  return layout.originX + x * (pitchProjection ? layout.pitchScale : layout.scale);
}

export function setBaseballWorldPosition(
  element: HTMLElement | null,
  x: number,
  y: number,
  layout: BaseballFieldLayout,
  scale = 1,
  pitchProjection = false,
): void {
  if (!element) {
    return;
  }
  element.style.transform = `translate3d(${baseballWorldScreenX(x, layout, pitchProjection)}px, ${layout.groundY - y * layout.scale}px, 0) scale(${scale})`;
}
