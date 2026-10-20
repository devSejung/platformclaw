import type { ChatSplitEdge } from "./split-layout.ts";

export type SplitDropZone = { kind: "edge"; edge: ChatSplitEdge } | { kind: "center" };
type SplitDropRect = { left: number; top: number; width: number; height: number };
export type SplitDropIndicator = { paneId: string; zone: SplitDropZone; rect: SplitDropRect };

const EDGE_BAND = 0.3;

export function resolveSplitDropIndicator(
  paneId: string,
  paneRect: SplitDropRect,
  containerRect: SplitDropRect,
  x: number,
  y: number,
): SplitDropIndicator {
  const zone = resolveSplitDropZone(paneRect, x, y);
  const rect = splitDropIndicatorRect(paneRect, zone);
  return {
    paneId,
    zone,
    rect: { ...rect, left: rect.left - containerRect.left, top: rect.top - containerRect.top },
  };
}

export function resolveSplitDropZone(rect: SplitDropRect, x: number, y: number): SplitDropZone {
  const nx = (x - rect.left) / rect.width;
  const ny = (y - rect.top) / rect.height;
  const horizontal =
    nx <= EDGE_BAND
      ? { edge: "left" as const, distance: nx }
      : 1 - nx <= EDGE_BAND
        ? { edge: "right" as const, distance: 1 - nx }
        : null;
  const vertical =
    ny <= EDGE_BAND
      ? { edge: "up" as const, distance: ny }
      : 1 - ny <= EDGE_BAND
        ? { edge: "down" as const, distance: 1 - ny }
        : null;
  const nearest =
    horizontal && vertical
      ? horizontal.distance <= vertical.distance
        ? horizontal
        : vertical
      : (horizontal ?? vertical);
  return nearest ? { kind: "edge", edge: nearest.edge } : { kind: "center" };
}

function splitDropIndicatorRect(rect: SplitDropRect, zone: SplitDropZone): SplitDropRect {
  const fullRect = {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
  if (zone.kind === "center") {
    return fullRect;
  }
  if (zone.edge === "left") {
    return { ...fullRect, width: rect.width / 2 };
  }
  if (zone.edge === "right") {
    return { ...fullRect, left: rect.left + rect.width / 2, width: rect.width / 2 };
  }
  if (zone.edge === "up") {
    return { ...fullRect, height: rect.height / 2 };
  }
  return { ...fullRect, top: rect.top + rect.height / 2, height: rect.height / 2 };
}
