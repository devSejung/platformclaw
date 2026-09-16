import { HIT_WINDOW_MS } from "./easter-egg-timing.ts";

export const BASEBALL_WORLD = {
  contactX: 0,
  groundY: 0,
  pitcherX: 18.44,
  pitchY: 1.05,
  fenceX: 100,
  fenceHeight: 3,
  gravity: 9.81,
} as const;

export const PITCH_SPEED_RANGE_KPH = { min: 115, max: 155 } as const;
export const SIMULATION_STEP_MS = 5;

export type BaseballPoint = { x: number; y: number };

export type Pitch = {
  speedKph: number;
  speedMps: number;
  idealContactTimeMs: number;
};

export type AtBatResult = {
  kind: "OUT" | "HIT" | "HOME_RUN";
  atMs: number;
  distanceM: number;
};

export type BattedBallSimulation = {
  elapsedMs: number;
  accumulatorMs: number;
  ball: BaseballPoint & { vx: number; vy: number };
  outfielder: {
    x: number;
    reactionDelayMs: number;
    speedMps: number;
    catchRadiusM: number;
    catchHeightM: number;
  };
  result: AtBatResult | null;
};

export function createPitch(random: () => number = Math.random): Pitch {
  const sample = Math.min(1, Math.max(0, random()));
  const speedKph =
    PITCH_SPEED_RANGE_KPH.min + sample * (PITCH_SPEED_RANGE_KPH.max - PITCH_SPEED_RANGE_KPH.min);
  const speedMps = speedKph / 3.6;
  return {
    speedKph,
    speedMps,
    idealContactTimeMs: ((BASEBALL_WORLD.pitcherX - BASEBALL_WORLD.contactX) / speedMps) * 1_000,
  };
}

export function pitchPositionAt(pitch: Pitch, elapsedMs: number): BaseballPoint {
  return {
    x: Math.max(
      BASEBALL_WORLD.contactX,
      BASEBALL_WORLD.pitcherX - pitch.speedMps * (Math.max(0, elapsedMs) / 1_000),
    ),
    y: BASEBALL_WORLD.pitchY,
  };
}

export function createBattedBall(options: {
  timingDeltaMs: number;
  batPower: number;
}): BattedBallSimulation {
  if (!Number.isFinite(options.timingDeltaMs) || Math.abs(options.timingDeltaMs) > HIT_WINDOW_MS) {
    throw new Error("batted-ball simulation requires successful contact");
  }
  if (!Number.isFinite(options.batPower) || options.batPower <= 0) {
    throw new Error("batPower must be positive");
  }
  const contactQuality = Math.max(0, 1 - Math.abs(options.timingDeltaMs) / HIT_WINDOW_MS);
  const launchSpeed = (22 + contactQuality * 24) * options.batPower;
  const launchAngle = ((28 + contactQuality * 10) * Math.PI) / 180;
  return {
    elapsedMs: 0,
    accumulatorMs: 0,
    ball: {
      x: BASEBALL_WORLD.contactX,
      y: BASEBALL_WORLD.pitchY,
      vx: Math.cos(launchAngle) * launchSpeed,
      vy: Math.sin(launchAngle) * launchSpeed,
    },
    outfielder: {
      x: 55,
      reactionDelayMs: 250,
      speedMps: 7,
      catchRadiusM: 1.35,
      catchHeightM: 1.5,
    },
    result: null,
  };
}

export function advanceBattedBall(
  simulation: BattedBallSimulation,
  deltaMs: number,
): BattedBallSimulation {
  if (!Number.isFinite(deltaMs) || deltaMs < 0) {
    throw new Error("deltaMs must be a finite non-negative number");
  }
  simulation.accumulatorMs += deltaMs;
  while (simulation.accumulatorMs + Number.EPSILON >= SIMULATION_STEP_MS && !simulation.result) {
    advanceFixedStep(simulation);
    simulation.accumulatorMs -= SIMULATION_STEP_MS;
  }
  return simulation;
}

function advanceFixedStep(simulation: BattedBallSimulation): void {
  const dt = SIMULATION_STEP_MS / 1_000;
  const previousBall = { x: simulation.ball.x, y: simulation.ball.y };
  const previousBallVy = simulation.ball.vy;
  const previousOutfielderX = simulation.outfielder.x;
  const nextElapsedMs = simulation.elapsedMs + SIMULATION_STEP_MS;

  simulation.ball.x += simulation.ball.vx * dt;
  simulation.ball.y += simulation.ball.vy * dt - 0.5 * BASEBALL_WORLD.gravity * dt * dt;
  simulation.ball.vy -= BASEBALL_WORLD.gravity * dt;

  if (nextElapsedMs >= simulation.outfielder.reactionDelayMs) {
    const targetX = Math.min(
      BASEBALL_WORLD.fenceX,
      Math.max(BASEBALL_WORLD.contactX, simulation.ball.x),
    );
    const maxMove = simulation.outfielder.speedMps * dt;
    simulation.outfielder.x += Math.max(
      -maxMove,
      Math.min(maxMove, targetX - simulation.outfielder.x),
    );
  }

  const event = earliestStepEvent(simulation, previousBall, previousOutfielderX, nextElapsedMs);
  simulation.elapsedMs = nextElapsedMs;
  if (event) {
    const eventX = interpolate(previousBall.x, simulation.ball.x, event.fraction);
    simulation.ball.x = eventX;
    simulation.ball.y = interpolate(previousBall.y, simulation.ball.y, event.fraction);
    simulation.ball.vy = interpolate(previousBallVy, simulation.ball.vy, event.fraction);
    simulation.outfielder.x = interpolate(
      previousOutfielderX,
      simulation.outfielder.x,
      event.fraction,
    );
    simulation.result = {
      kind: event.kind,
      atMs: nextElapsedMs - SIMULATION_STEP_MS + event.fraction * SIMULATION_STEP_MS,
      distanceM:
        event.kind === "HOME_RUN"
          ? Math.max(0, projectedLandingX(simulation.ball) - BASEBALL_WORLD.contactX)
          : Math.max(0, eventX - BASEBALL_WORLD.contactX),
    };
  }
}

type StepEvent = { kind: AtBatResult["kind"]; fraction: number; priority: number };

function earliestStepEvent(
  simulation: BattedBallSimulation,
  previousBall: BaseballPoint,
  previousOutfielderX: number,
  nextElapsedMs: number,
): StepEvent | null {
  const events: StepEvent[] = [];
  const landingFraction = descendingCrossingFraction(
    previousBall.y,
    simulation.ball.y,
    BASEBALL_WORLD.groundY,
  );
  if (landingFraction !== null) {
    events.push({ kind: "HIT", fraction: landingFraction, priority: 2 });
  }

  const fenceFraction = crossingFraction(previousBall.x, simulation.ball.x, BASEBALL_WORLD.fenceX);
  if (fenceFraction !== null) {
    const fenceY = interpolate(previousBall.y, simulation.ball.y, fenceFraction);
    events.push({
      kind: fenceY > BASEBALL_WORLD.fenceHeight ? "HOME_RUN" : "HIT",
      fraction: fenceFraction,
      priority: 1,
    });
  }

  const stepStartedAfterReaction =
    nextElapsedMs - SIMULATION_STEP_MS >= simulation.outfielder.reactionDelayMs;
  if (stepStartedAfterReaction) {
    const catchFraction = segmentCircleEntryFraction(
      {
        x: previousBall.x - previousOutfielderX,
        y: previousBall.y - simulation.outfielder.catchHeightM,
      },
      {
        x: simulation.ball.x - simulation.outfielder.x,
        y: simulation.ball.y - simulation.outfielder.catchHeightM,
      },
      simulation.outfielder.catchRadiusM,
    );
    if (catchFraction !== null) {
      events.push({ kind: "OUT", fraction: catchFraction, priority: 0 });
    }
  }

  return (
    events.toSorted(
      (left, right) => left.fraction - right.fraction || left.priority - right.priority,
    )[0] ?? null
  );
}

function crossingFraction(start: number, end: number, boundary: number): number | null {
  if (start >= boundary || end < boundary || end === start) {
    return null;
  }
  return (boundary - start) / (end - start);
}

function descendingCrossingFraction(start: number, end: number, boundary: number): number | null {
  if (start <= boundary || end > boundary || end === start) {
    return null;
  }
  return (start - boundary) / (start - end);
}

function segmentCircleEntryFraction(
  start: BaseballPoint,
  end: BaseballPoint,
  radius: number,
): number | null {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const a = dx * dx + dy * dy;
  const c = start.x * start.x + start.y * start.y - radius * radius;
  if (c <= 0) {
    return 0;
  }
  if (a === 0) {
    return null;
  }
  const b = 2 * (start.x * dx + start.y * dy);
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) {
    return null;
  }
  const entry = (-b - Math.sqrt(discriminant)) / (2 * a);
  return entry >= 0 && entry <= 1 ? entry : null;
}

function interpolate(start: number, end: number, fraction: number): number {
  return start + (end - start) * fraction;
}

function projectedLandingX(ball: BattedBallSimulation["ball"]): number {
  const timeToGround =
    (ball.vy +
      Math.sqrt(
        ball.vy * ball.vy +
          2 * BASEBALL_WORLD.gravity * Math.max(0, ball.y - BASEBALL_WORLD.groundY),
      )) /
    BASEBALL_WORLD.gravity;
  return ball.x + ball.vx * timeToGround;
}
