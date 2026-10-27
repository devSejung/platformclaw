import { afterEach, describe, expect, it, vi } from "vitest";
import { FishingScene, type FishingSceneState } from "./fishing-scene.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

type DrawnPoint = { x: number; y: number };
function sceneCanvas() {
  const drawing = {
    rope: [] as DrawnPoint[],
    tip: { x: 0, y: 0 },
    bobber: { x: 0, y: 0 },
    fishScale: [0, 0],
  };
  let path: DrawnPoint[] = [];
  const noop = () => {
    // The recorder observes coordinates, rather than rasterizing pixels.
  };
  const context = {
    lineWidth: 0,
    setTransform: noop,
    clearRect: noop,
    save: noop,
    restore: noop,
    translate: noop,
    fill: noop,
    closePath: noop,
    fillRect: noop,
    ellipse: noop,
    bezierCurveTo: noop,
    scale(x: number, y: number) {
      drawing.fishScale = [x, y];
    },
    beginPath() {
      path = [];
    },
    moveTo(x: number, y: number) {
      path.push({ x, y });
    },
    lineTo(x: number, y: number) {
      path.push({ x, y });
    },
    stroke() {
      if (this.lineWidth === 0.7) {
        drawing.rope = path;
      }
    },
    quadraticCurveTo(_controlX: number, _controlY: number, x: number, y: number) {
      drawing.tip = { x, y };
    },
    arc(x: number, y: number, radius: number) {
      if (radius === 1.5) {
        drawing.bobber = { x, y };
      }
    },
  };
  const canvas = document.createElement("canvas");
  vi.spyOn(canvas, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
  Object.defineProperty(canvas, "clientWidth", { value: 460 });
  return { canvas, drawing };
}
const sceneState = (extra: Partial<FishingSceneState> = {}): FishingSceneState => ({
  phase: "fighting",
  time: 0,
  phaseTime: 0,
  tension: 0.6,
  progress: 0.5,
  holding: true,
  reducedMotion: false,
  fishLengthCm: null,
  escapeReason: null,
  ...extra,
});

describe("fishing scene drawing", () => {
  it("draws larger caught fish at larger scales and keeps an anonymous fish finite", () => {
    const { canvas, drawing } = sceneCanvas();
    const scene = new FishingScene();
    const scales = [10, 35, 200].map((fishLengthCm) => {
      scene.paint(canvas, sceneState({ phase: "success", fishLengthCm }));
      expect(Math.abs(drawing.fishScale[0]!)).toBe(drawing.fishScale[1]);
      return drawing.fishScale[1]!;
    });
    expect(scales[0]).toBeGreaterThan(0);
    expect(scales[0]).toBeLessThan(scales[1]!);
    expect(scales[1]).toBeLessThan(scales[2]!);
    scene.paint(canvas, sceneState());
    expect(drawing.fishScale.every((scale) => Number.isFinite(scale) && scale > 0)).toBe(true);
  });

  it.each([15, 30, 60, 120])("draws an anchored finite bounded rope at %s fps", (fps) => {
    const { canvas, drawing } = sceneCanvas();
    const scene = new FishingScene();
    for (let frame = 0; frame < fps * 10; frame++) {
      const time = (frame * 1000) / fps;
      scene.paint(canvas, sceneState({ time, phaseTime: time }));
      expect(drawing.rope).toHaveLength(18);
      expect(drawing.rope[0]).toEqual(drawing.tip);
      expect(drawing.rope.at(-1)).toEqual(drawing.bobber);
      expect(
        drawing.rope.every(
          (point) =>
            Number.isFinite(point.x) &&
            Number.isFinite(point.y) &&
            point.x > 50 &&
            point.x < 400 &&
            point.y > 50 &&
            point.y < 240,
        ),
      ).toBe(true);
    }
  });
});
