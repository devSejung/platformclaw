import { Easing, interpolate, spring } from "remotion";
export const clamp = (n: number) => Math.max(0, Math.min(1, n));
export const mix = (a: number, b: number, t: number) => a + (b - a) * t;
export const beat = (time: number, start: number, end: number) =>
  Easing.bezier(0.22, 1, 0.36, 1)(clamp((time - start) / (end - start)));
export const reveal = (frame: number, at: number, fps: number) =>
  spring({
    frame: frame - at * fps,
    fps,
    config: { damping: 26, stiffness: 170, mass: 0.9 },
  });
export const fade = (time: number, start: number, end: number) =>
  interpolate(time, [start, start + 0.35, end - 0.3, end], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
