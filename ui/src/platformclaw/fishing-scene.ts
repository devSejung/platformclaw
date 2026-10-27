import type { FishingFight } from "../../../packages/platformclaw-control-plane/src/fishing-contracts.ts";

export type FishingScenePhase =
  | "idle"
  | "prepare"
  | "casting"
  | "splash"
  | "waiting"
  | "nibble"
  | "bite"
  | "hook"
  | "fighting"
  | "finishing"
  | "landing"
  | "success"
  | "miss";
export type FishingSceneState = {
  phase: FishingScenePhase;
  time: number;
  phaseTime: number;
  tension: number;
  progress: number;
  holding: boolean;
  reducedMotion: boolean;
  fishLengthCm: number | null;
  escapeReason: FishingFight["escapeReason"];
};
type Point = { x: number; y: number };
type RopePoint = Point & { oldX: number; oldY: number };
const WIDTH = 460;
const HEIGHT = 165;
const TOP = 65;
const WATER = 184;
const INK = "#292c2d";

/** Square-root scaling keeps tiny and giant specimens legible within the small dock. */
export function fishingFishScale(lengthCm: number | null): number {
  return lengthCm === null ? 0.72 : 0.8 * Math.sqrt(lengthCm / 25);
}

function ease(value: number): number {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

/** Fixed-size visual rope, independent of authoritative gameplay and frame rate. */
export class FishingLine {
  readonly points: RopePoint[] = Array.from({ length: 18 }, () => ({
    x: 142,
    y: 135,
    oldX: 142,
    oldY: 135,
  }));
  private accumulator = 0;

  reset(start: Point, end: Point): void {
    this.accumulator = 0;
    this.points.forEach((point, index) => {
      const t = index / (this.points.length - 1);
      point.x = point.oldX = start.x + (end.x - start.x) * t;
      point.y = point.oldY = start.y + (end.y - start.y) * t;
    });
  }

  advance(start: Point, end: Point, deltaMs: number, tension: number): void {
    // A hidden tab never accumulates simulation debt. Constraint projection also
    // handles a fast cast without detaching the hand, tip or bobber anchors.
    this.accumulator += Math.max(0, Math.min(deltaMs, 100));
    const segment =
      (Math.hypot(end.x - start.x, end.y - start.y) *
        (1.07 - Math.min(1, Math.max(0, tension)) * 0.065)) /
      (this.points.length - 1);
    while (this.accumulator >= 1000 / 60) {
      this.accumulator -= 1000 / 60;
      for (const point of this.points.slice(1, -1)) {
        const x = point.x;
        const y = point.y;
        point.x += (point.x - point.oldX) * 0.88;
        point.y += (point.y - point.oldY) * 0.88 + 0.045;
        point.oldX = x;
        point.oldY = y;
      }
      for (let pass = 0; pass < 10; pass++) {
        // This rope always has18 points; adjacent indices stay inside the
        // fixed array throughout constraint projection.
        Object.assign(this.points[0]!, start);
        Object.assign(this.points[this.points.length - 1]!, end);
        for (let index = 1; index < this.points.length; index++) {
          const a = this.points[index - 1]!;
          const b = this.points[index]!;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const distance = Math.hypot(dx, dy);
          if (distance < 0.001) {
            continue;
          }
          const correction = ((distance - segment) / distance) * 0.5;
          if (index > 1) {
            a.x += dx * correction;
            a.y += dy * correction;
          }
          if (index < this.points.length - 1) {
            b.x -= dx * correction;
            b.y -= dy * correction;
          }
        }
      }
    }
    Object.assign(this.points[0]!, start);
    Object.assign(this.points[this.points.length - 1]!, end);
  }
}

function stroke(ctx: CanvasRenderingContext2D, points: Point[], width = 1.35): void {
  ctx.lineWidth = width;
  ctx.beginPath();
  points.forEach((point, index) =>
    index === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y),
  );
  ctx.stroke();
}

function fish(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  scale: number,
  direction: number,
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale * direction, scale);
  ctx.beginPath();
  ctx.moveTo(-8, 0);
  ctx.bezierCurveTo(-2, -5, 5, -5, 9, 0);
  ctx.bezierCurveTo(5, 5, -2, 5, -8, 0);
  ctx.lineTo(-12, -4);
  ctx.lineTo(-12, 4);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** All art is original vector drawing. No sprites, font downloads or remote assets. */
export class FishingScene {
  private readonly line = new FishingLine();
  private previousTime: number | null = null;
  private previousPhase: FishingScenePhase | null = null;
  private poseAngle = -0.7;

  paint(canvas: HTMLCanvasElement, state: FishingSceneState): void {
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round((width * HEIGHT) / WIDTH));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    ctx.setTransform(width / WIDTH, 0, 0, height / HEIGHT, 0, 0);
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    // Draw only the figure and water line over chat; the canvas stays clear.
    ctx.translate(0, -TOP);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = INK;
    ctx.fillStyle = INK;
    const time = state.reducedMotion ? 0 : state.time / 1000;
    const breath = Math.sin(time * 1.8) * 0.55;
    const fight = state.phase === "fighting";
    const broken = state.phase === "miss" && state.escapeReason === "line_broken";
    const escaped = state.phase === "miss" && state.escapeReason !== null;
    const fishScale = fishingFishScale(state.fishLengthCm);
    const tug = fight && !state.reducedMotion ? Math.sin(time * 13) * state.tension : 0;
    let angle = -0.7 + breath * 0.006;
    if (state.phase === "prepare") {
      angle -= ease(state.phaseTime / 550) * 1.7;
    } else if (state.phase === "casting") {
      angle = -2.4 + ease(state.phaseTime / 1400) * 2.15;
    } else if (
      fight ||
      state.phase === "hook" ||
      state.phase === "landing" ||
      state.phase === "finishing"
    ) {
      angle = -1.04 - state.tension * 0.3 + tug * 0.018;
    } else if (state.phase === "miss") {
      angle = -0.25;
    } else if (state.phase === "success") {
      angle = -1.5;
    }
    const delta = this.previousTime === null ? 17 : Math.max(0, state.time - this.previousTime);
    // Blend about the shared hand joint so state changes never snap the rod
    // between the last cast pose and the waiting/fighting pose.
    this.poseAngle =
      this.previousTime === null || state.reducedMotion
        ? angle
        : this.poseAngle + (angle - this.poseAngle) * (1 - Math.exp(-Math.min(delta, 100) / 60));
    angle = this.poseAngle;
    const hip = { x: 84, y: 165 };
    const shoulder = { x: 82 - (fight ? 2 : 0), y: 148 + breath };
    const grip = { x: 96 + Math.cos(angle) * 2, y: 154 + breath };
    const tip = { x: grip.x + Math.cos(angle) * 59, y: grip.y + Math.sin(angle) * 59 };
    const cast = ease(state.phaseTime / 1400);
    let bobber: Point = { x: 309, y: WATER - 1 };
    if (state.phase === "idle" || state.phase === "prepare") {
      bobber = { x: tip.x + 7, y: tip.y + 23 };
    } else if (state.phase === "casting") {
      const launch = { x: grip.x + Math.cos(-2.4) * 59 + 7, y: grip.y + Math.sin(-2.4) * 59 + 23 };
      bobber = {
        x: launch.x + (309 - launch.x) * cast,
        y: launch.y + (183 - launch.y) * cast - Math.sin(cast * Math.PI) * 83,
      };
    } else if (fight) {
      bobber = {
        x: 309 - state.progress * 146 + Math.sin(time * 3) * 8,
        y: WATER + 11 + Math.sin(time * 5) * 5,
      };
    } else if (
      state.phase === "landing" ||
      state.phase === "success" ||
      state.phase === "finishing"
    ) {
      const landed =
        state.phase === "success" || state.phase === "finishing" ? 1 : ease(state.phaseTime / 800);
      bobber = { x: 163 - landed * 45, y: WATER + 5 - Math.sin((landed * Math.PI) / 2) * 44 };
    } else if (state.phase === "bite" || state.phase === "hook") {
      bobber.y += 5 + Math.sin(time * 18) * 2;
    } else if (state.phase === "nibble") {
      bobber.y += Math.sin(time * 15) * 1.5;
    }
    // A fine bank and water line suggest the setting without a background panel.
    ctx.strokeStyle = "#b9c0bb";
    stroke(
      ctx,
      [
        { x: 35, y: WATER - 1 },
        { x: 112, y: WATER - 1 },
        { x: 121, y: WATER + 3 },
      ],
      0.9,
    );
    ctx.strokeStyle = "#78a4ae";
    stroke(
      ctx,
      [
        { x: 121, y: WATER + 3 },
        { x: 420, y: WATER + 3 },
      ],
      0.85,
    );
    ctx.globalAlpha = 0.38;
    ctx.fillStyle = "#687775";
    const fishX = escaped
      ? 309 + Math.min(1, state.phaseTime / 700) * 145
      : fight
        ? bobber.x
        : 266 + Math.sin(time * 0.4) * 45;
    if (!["landing", "success", "finishing"].includes(state.phase)) {
      if (escaped) ctx.globalAlpha *= Math.max(0, 1 - state.phaseTime / 700);
      fish(
        ctx,
        fishX,
        fight ? bobber.y + 3 : WATER + 25,
        fishScale,
        escaped ? 1 : Math.cos(time * 0.4) > 0 ? 1 : -1,
      );
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = INK;
    ctx.fillStyle = INK;
    // Chair, pelvis, spine, head and two-link arms share their joint coordinates.
    stroke(
      ctx,
      [
        { x: 73, y: 167 },
        { x: 91, y: 167 },
        { x: 93, y: WATER - 1 },
      ],
      1,
    );
    stroke(
      ctx,
      [
        { x: 75, y: 167 },
        { x: 72, y: WATER - 1 },
      ],
      1,
    );
    stroke(ctx, [shoulder, hip, { x: 99, y: 165 }, { x: 105, y: 179 }, { x: 111, y: 179 }]);
    stroke(ctx, [hip, { x: 91, y: 170 }, { x: 91, y: 182 }, { x: 97, y: 182 }]);
    const slouch = state.phase === "miss" ? 2 : 0;
    ctx.beginPath();
    ctx.arc(shoulder.x + slouch, shoulder.y - 8 + slouch, 5, 0, Math.PI * 2);
    ctx.stroke();
    stroke(ctx, [shoulder, { x: 87, y: 157 + breath }, grip]);
    stroke(ctx, [{ x: shoulder.x + 1, y: shoulder.y + 2 }, { x: 91, y: 150 + breath }, grip]);
    // Rod flexes at its tip under load, with the grip fixed to both hands.
    ctx.beginPath();
    ctx.moveTo(grip.x, grip.y);
    ctx.quadraticCurveTo(tip.x - state.tension * 14, tip.y - state.tension * 16, tip.x, tip.y);
    ctx.lineWidth = 1.15;
    ctx.stroke();
    if (this.previousPhase !== state.phase || state.reducedMotion) {
      this.line.reset(tip, bobber);
    }
    this.line.advance(tip, bobber, delta, fight ? state.tension : 0.1);
    this.previousTime = state.time;
    this.previousPhase = state.phase;
    if (broken) {
      // A broken line never reconnects to the bobber; its free end recoils to the rod.
      const recoil = state.reducedMotion ? 1 : ease(state.phaseTime / 450);
      const end = {
        x: tip.x + (bobber.x - tip.x) * (0.45 - recoil * 0.4),
        y: tip.y + 18 + (bobber.y - tip.y) * (1 - recoil) * 0.45,
      };
      stroke(ctx, [tip, end], 0.7);
      if (state.phaseTime < 450) {
        ctx.strokeStyle = "#bd553e";
        stroke(
          ctx,
          [
            { x: end.x - 4, y: end.y - 4 },
            { x: end.x + 4, y: end.y + 4 },
          ],
          1.5,
        );
        stroke(
          ctx,
          [
            { x: end.x + 4, y: end.y - 4 },
            { x: end.x - 4, y: end.y + 4 },
          ],
          1.5,
        );
        ctx.strokeStyle = INK;
      }
    } else {
      stroke(ctx, this.line.points, 0.7);
    }
    if (state.phase === "success" || state.phase === "landing" || state.phase === "finishing") {
      fish(ctx, bobber.x, bobber.y + 7, fishScale, -1);
    } else if (!broken) {
      ctx.fillStyle = "#c07560";
      ctx.fillRect(bobber.x - 1, bobber.y - 5, 2, 5);
      ctx.fillStyle = INK;
      ctx.beginPath();
      ctx.arc(bobber.x, bobber.y, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
    if (["splash", "nibble", "bite", "fighting"].includes(state.phase)) {
      ctx.strokeStyle = "#78a4ae";
      for (let index = 0; index < 3; index++) {
        const radius = 2 + ((time * 11 + index * 8) % 26);
        ctx.globalAlpha = (1 - radius / 30) * 0.6;
        ctx.beginPath();
        ctx.ellipse(bobber.x, WATER + 2, radius, radius * 0.18, 0, 0, Math.PI * 2);
        ctx.lineWidth = 0.6;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  }
}
