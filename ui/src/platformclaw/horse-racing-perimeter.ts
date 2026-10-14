type HorsePerimeterPoint = { x: number; y: number; angle: 0 | 90 | 180 | 270 };
const PERIMETER_FACINGS = { 0: "right", 90: "front", 180: "left", 270: "back" } as const;

/** Server progress covers three laps. Interpolate progress, then map to the path to avoid corner shortcuts. */
export function horsePerimeterPoint(
  width: number,
  height: number,
  position: number,
  lane: number,
): HorsePerimeterPoint {
  const inset = Math.min(20 + lane * (width < 480 ? 4 : 7), Math.min(width, height) / 3);
  const trackWidth = Math.max(1, width - inset * 2);
  const trackHeight = Math.max(1, height - inset * 2);
  const perimeter = (trackWidth + trackHeight) * 2;
  const progress = Math.max(0, Math.min(100, position)) / 100;
  let distance = ((progress * 3) % 1) * perimeter;
  const firstStraight = trackWidth / 2;
  if (distance <= firstStraight) {
    return { x: width / 2 + distance, y: inset, angle: 0 };
  }
  distance -= firstStraight;
  if (distance <= trackHeight) {
    return { x: width - inset, y: inset + distance, angle: 90 };
  }
  distance -= trackHeight;
  if (distance <= trackWidth) {
    return { x: width - inset - distance, y: height - inset, angle: 180 };
  }
  distance -= trackWidth;
  if (distance <= trackHeight) {
    return { x: inset, y: height - inset - distance, angle: 270 };
  }
  distance -= trackHeight;
  return { x: inset + distance, y: inset, angle: 0 };
}

export function horsePerimeterFacing(
  angle: HorsePerimeterPoint["angle"],
): "right" | "front" | "left" | "back" {
  return PERIMETER_FACINGS[angle];
}

/** Upright name badges alternate around each lane and stay within the resized viewport. */
export function horsePerimeterLabel(
  width: number,
  height: number,
  point: HorsePerimeterPoint,
  lane: number,
) {
  const labelWidth = 58;
  const horizontal = point.angle === 0 || point.angle === 180;
  const x = horizontal
    ? point.x + (lane % 2 ? 24 : -82)
    : point.x + (point.angle === 90 ? -82 : 24);
  const y = horizontal ? point.y + 4 : point.y + (lane % 2 ? 21 : -17);
  return {
    x: Math.max(4, Math.min(width - labelWidth - 4, x)),
    y: Math.max(14, Math.min(height - 6, y)),
  };
}
