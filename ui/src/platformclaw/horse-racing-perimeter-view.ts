import { html, nothing, svg } from "lit";
import { styleMap } from "lit/directives/style-map.js";
import type { HorseRaceSnapshot } from "../../../packages/platformclaw-control-plane/src/horse-racing-contracts.ts";
import {
  horsePerimeterFacing,
  horsePerimeterPoint,
  horsePerimeterLabel,
} from "./horse-racing-perimeter.ts";

export function renderHorsePerimeter(
  race: HorseRaceSnapshot | null,
  width: number,
  height: number,
  positions: ReadonlyMap<string, number>,
  stale: boolean,
  reducedMotion: boolean,
) {
  if (!race || race.status !== "racing") {
    return nothing;
  }
  const backed = new Set(
    race.myBets.filter((bet) => bet.cancelledAt === null).flatMap((bet) => bet.selection),
  );
  return html`<svg
    class="platformclaw-racing-perimeter ${stale || reducedMotion
      ? "platformclaw-racing-perimeter--paused"
      : ""}"
    viewBox=${`0 0 ${width} ${height}`}
    aria-hidden="true"
  >
    <rect
      class="platformclaw-racing-perimeter__rail"
      x="12"
      y="12"
      width=${Math.max(1, width - 24)}
      height=${Math.max(1, height - 24)}
    />
    <path
      class="platformclaw-racing-perimeter__finish"
      d=${`M${width / 2} 8v${width < 480 ? 38 : 54}`}
    />
    ${race.horses.map((horse, lane) => {
      const point = horsePerimeterPoint(width, height, positions.get(horse.id) ?? 0, lane);
      const label = horsePerimeterLabel(width, height, point, lane);
      return svg`<g data-perimeter-horse=${horse.id}
        class="platformclaw-racing-perimeter__horse ${backed.has(horse.id) ? "platformclaw-racing-perimeter__horse--backed" : ""}"
        data-facing=${horsePerimeterFacing(point.angle)} transform=${`translate(${point.x} ${point.y})`} style=${styleMap({ "--horse-color": horse.color })}>
        <title>${lane + 1}. ${horse.name}</title>
        <g data-horse-facing="right">${renderHorseSide(lane + 1, false)}</g>
        <g data-horse-facing="left">${renderHorseSide(lane + 1, true)}</g>
        <g data-horse-facing="front" transform="scale(.75)">
          <ellipse class="platformclaw-racing-perimeter__shadow" cy="14" rx="11" ry="3" />
          <path class="platformclaw-racing-perimeter__legs" d="M-6 5-7 13M6 5 7 13" />
          <ellipse fill="#7d6d5b" cy="-2" rx="8" ry="7" />
          <path fill="var(--horse-color)" d="M-5-10h10v9H-5Z" />
          <circle fill="#dfd7c9" cy="-13" r="3" />
          <path fill="var(--horse-color)" d="M-4-13q4-7 8 0Z" />
          <path fill="#6b5b4b" d="M-5-6-6-12-2-7M5-6 6-12 2-7" />
          <ellipse fill="#96806a" cy="2" rx="6" ry="8" />
          <ellipse fill="#c4b39e" cy="8" rx="6" ry="3" />
          <path stroke="#292624" stroke-width="1.5" d="M-4 0h2M2 0h2M-3 8h1M2 8h1" />
          <text y="-3" text-anchor="middle" fill="#f3eee3" font-size="6" font-weight="800">${lane + 1}</text>
        </g>
        <g data-horse-facing="back" transform="scale(.75)">
          <ellipse class="platformclaw-racing-perimeter__shadow" cy="14" rx="11" ry="3" />
          <path class="platformclaw-racing-perimeter__legs" d="M-6 5-7 13M6 5 7 13" />
          <ellipse fill="#7d6d5b" cy="2" rx="8" ry="8" />
          <path fill="var(--horse-color)" d="M-5-10h10v9H-5Z" />
          <circle fill="#dfd7c9" cy="-13" r="3" />
          <path fill="var(--horse-color)" d="M-4-13q4-7 8 0Z" />
          <path fill="#51483f" d="M-2 4q8 8 1 13L-2 13Q1 8-2 4Z" />
          <path stroke="#554b42" stroke-width="1" d="M-6 1q6 3 12 0" fill="none" />
          <text y="-3" text-anchor="middle" fill="#f3eee3" font-size="6" font-weight="800">${lane + 1}</text>
        </g>
      </g><text data-horse-label=${horse.id} class="platformclaw-racing-perimeter__label" x=${label.x} y=${label.y}>${lane + 1} ${horse.name}</text>`;
    })}
  </svg>`;
}

function renderHorseSide(number: number, left: boolean) {
  return svg`<g transform="scale(.75)"><g transform=${left ? "scale(-1 1)" : "scale(1 1)"}>
    <ellipse class="platformclaw-racing-perimeter__shadow" cx="-2" cy="14" rx="17" ry="3" />
    <path class="platformclaw-racing-perimeter__legs" d="M-10 3-13 12M3 3 7 12" />
    <ellipse fill="#7d6d5b" cx="-3" rx="11" ry="5" />
    <path fill="#7d6d5b" d="M5-2 8-10 15-10 20-5 18-1 12-5 7 3Z" />
    <path fill="#554b42" d="M10-10 11-15 14-10M-13-3-20-7-18 3-13 2Z" />
    <path fill="var(--horse-color)" d="M-8-4H2V4H-8Z" />
    <path fill="var(--horse-color)" d="M-7-6-5-13 1-13 4-7Z" />
    <circle fill="#dfd7c9" cx="-1" cy="-16" r="3" />
    <path fill="var(--horse-color)" d="M-5-16q4-7 8 0Z" />
    <path stroke="#d0c5b5" stroke-width="2" d="M1-12 9-9 14-6" fill="none" />
    <circle fill="#292624" cx="15" cy="-7" r="1" />
  </g><text x=${left ? "3" : "-3"} y="2" text-anchor="middle" fill="#f3eee3" font-size="6" font-weight="800">${number}</text></g>`;
}
