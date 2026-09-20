import { BASEBALL_WORLD, type BaseballPoint } from "./easter-egg-simulation.ts";

const BASELINE_OFFSET_PX = 138;

type BaseballFieldLayout = {
  originX: number;
  groundY: number;
  height: number;
  pitchScale: number;
  scale: number;
  uiLeft: number;
  width: number;
};

type BaseballStaticFieldParams = {
  arena: HTMLElement | null;
  fence: HTMLElement | null;
  host: HTMLElement;
  leaderboard: HTMLElement | null;
  outfielder: HTMLElement | null;
  outfielderX: number;
  pitcher: HTMLElement | null;
  player: HTMLElement | null;
};

type BaseballProjectileParams = {
  arena: HTMLElement | null;
  host: HTMLElement;
  pitchProjection: boolean;
  point: BaseballPoint | null;
  projectile: HTMLElement | null;
  trail: readonly BaseballPoint[];
  trailElements: readonly HTMLElement[];
  trailPointLimit: number;
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

function baseballWorldScreenX(
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

export function layoutBaseballStaticField(params: BaseballStaticFieldParams): void {
  const layout = resolveBaseballFieldLayout(params.host, params.arena);
  setBaseballWorldPosition(params.player, BASEBALL_WORLD.contactX, 0, layout);
  setBaseballWorldPosition(params.pitcher, BASEBALL_WORLD.pitcherX, 0, layout, 1, true);
  setBaseballWorldPosition(params.outfielder, params.outfielderX, 0, layout);
  params.host.style.setProperty("--platformclaw-baseball-ui-left", `${layout.uiLeft}px`);
  if (!params.fence) {
    return;
  }
  const fenceX = baseballWorldScreenX(BASEBALL_WORLD.fenceX, layout);
  params.fence.style.left = `${fenceX}px`;
  params.fence.style.top = `${layout.groundY - BASEBALL_WORLD.fenceHeight * layout.scale}px`;
  params.fence.style.height = `${BASEBALL_WORLD.fenceHeight * layout.scale}px`;
  if (params.leaderboard) {
    params.leaderboard.style.right = `${Math.max(8, layout.width - fenceX - 2)}px`;
    params.leaderboard.style.bottom = `${layout.height - layout.groundY + BASEBALL_WORLD.fenceHeight * layout.scale}px`;
  }
}

export function renderBaseballProjectile(params: BaseballProjectileParams): void {
  const layout = resolveBaseballFieldLayout(params.host, params.arena);
  if (params.projectile) {
    params.projectile.style.opacity = params.point ? "1" : "0";
    if (params.point) {
      setBaseballWorldPosition(
        params.projectile,
        params.point.x,
        params.point.y,
        layout,
        1,
        params.pitchProjection,
      );
    }
  }
  const points = params.trail.slice(-params.trailPointLimit);
  params.trailElements.forEach((element, index) => {
    const trailPoint = points[points.length - 1 - index];
    if (!trailPoint) {
      element.style.opacity = "0";
      return;
    }
    const age = index / Math.max(1, params.trailPointLimit - 1);
    element.style.opacity = String((1 - age) * 0.42);
    setBaseballWorldPosition(
      element,
      trailPoint.x,
      trailPoint.y,
      layout,
      0.92 - age * 0.28,
      params.pitchProjection,
    );
  });
}
