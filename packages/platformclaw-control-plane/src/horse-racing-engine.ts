import { createHash } from "node:crypto";
import type { HorseRacePosition, RacingHorse } from "./horse-racing-contracts.js";
import {
  HORSE_RACING_ALGORITHM_VERSION,
  HORSE_RACING_ANIMATION_VERSION,
  HORSE_RACING_JOKER_ID,
} from "./horse-racing-contracts.js";
import { horseRaceScenarios, selectHorseRaceScenario } from "./horse-racing-profile.js";
export {
  HORSE_RACING_ALGORITHM_VERSION,
  HORSE_RACING_ANIMATION_VERSION,
} from "./horse-racing-contracts.js";

// Pace/fatigue adaptation: Horse Chaos api/src/game/race-engine.service.ts,
// oconsl/websocket-horse-chaos-example@4ccafdcaef1520f40f75149362e7907adcfccf03 (MIT; THIRD_PARTY_NOTICES.md).

export const HORSE_RACE_DURATION_MS = 180_000;
const HORSE_RACE_BETTING_WINDOW_MS = 10 * 60_000;
export const HORSE_RACE_LOCK_BEFORE_MS = 60_000;
const HORSE_RACE_REST_MS = 10_000;
const HORSE_RACE_INTERVAL_MS = 30 * 60_000;
const FIRST_HORSE_RACE_HOUR = 9;
const LAST_HORSE_RACE_HOUR = 19;
const KST_OFFSET_MS = 9 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

const HORSE_ROSTER = [
  {
    id: "1",
    name: "모리",
    color: "#f05b67",
    speed: 94,
    stamina: 80,
    weight: 32,
    form: 85,
    swing: 15,
    stories: [
      "모리는 하니의 발굽 소리만 들리면 귀를 쫑긋한대요.",
      "모리의 기수가 오늘도 선두 자리를 예약했다고 큰소리쳤대요.",
      "모리는 연습장에서도 하니가 어디 있는지부터 확인한대요.",
    ],
  },
  {
    id: "2",
    name: "파리",
    color: "#58a6ff",
    speed: 76,
    stamina: 94,
    weight: 19,
    form: 80,
    swing: 12,
    stories: [
      "파리는 나이 이야기가 나오면 결승선부터 가리킨대요.",
      "파리의 기수는 '급할수록 오래 달려라'라는 말을 입에 달고 살아요.",
      "파리는 신참들 옆에서 느긋하게 스트레칭을 했대요.",
    ],
  },
  {
    id: "3",
    name: "포운",
    color: "#ffd166",
    speed: 82,
    stamina: 72,
    weight: 12,
    form: 78,
    swing: 24,
    stories: [
      "포운은 출전표를 보고 자기 이름부터 두 번 확인했대요.",
      "포운은 오늘 첫 인터뷰 답변을 연습하다 웃음을 터뜨렸대요.",
      "포운의 기수는 신참의 패기가 가끔 계획을 앞지른다고 하네요.",
    ],
  },
  {
    id: "4",
    name: "로시",
    color: "#52d6a4",
    speed: 70,
    stamina: 77,
    weight: 8,
    form: 78,
    swing: 4,
    stories: [
      "로시는 오늘도 어제와 같은 시간에 건초를 먹었대요.",
      "로시의 기수는 화려한 약속 대신 꾸준한 발걸음을 믿는대요.",
      "로시는 취재진이 몰려도 평소 보폭으로 산책을 마쳤대요.",
    ],
  },
  {
    id: "5",
    name: "하니",
    color: "#b794f4",
    speed: 90,
    stamina: 78,
    weight: 25,
    form: 84,
    swing: 14,
    stories: [
      "하니는 모리의 우승 인터뷰를 듣다가 코웃음을 쳤대요.",
      "하니의 기수는 모리와 나란히 서면 말이 조금 더 눈을 빛낸대요.",
      "하니는 출발선에서 모리 쪽으로 고개를 돌렸다는 소문이에요.",
    ],
  },
  {
    id: HORSE_RACING_JOKER_ID,
    name: "쥬기",
    color: "#d8e2f0",
    speed: 55,
    stamina: 50,
    weight: 4,
    form: 35,
    swing: 10,
    stories: [
      "쥬기의 기수도 오늘 계획은 나도 모르겠다고 했대요.",
      "쥬기는 당근을 보고 웃은 건지 하품한 건지 아무도 모른대요.",
      "쥬기는 출발선보다 관중석 간식 코너가 더 궁금해 보였대요.",
    ],
  },
] as const;

export function getHorseRaceDayStarts(now: number): number[] {
  const local = new Date(now + KST_OFFSET_MS);
  if (local.getUTCDay() === 0 || local.getUTCDay() === 6) {
    return [];
  }
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  return Array.from(
    {
      length:
        ((LAST_HORSE_RACE_HOUR - FIRST_HORSE_RACE_HOUR) * 3_600_000) / HORSE_RACE_INTERVAL_MS + 1,
    },
    (_, index) =>
      midnight + FIRST_HORSE_RACE_HOUR * 3_600_000 + index * HORSE_RACE_INTERVAL_MS - KST_OFFSET_MS,
  );
}

export function horseRaceOpensAt(startsAt: number): number {
  const local = new Date(startsAt + KST_OFFSET_MS);
  if (local.getUTCHours() === FIRST_HORSE_RACE_HOUR && local.getUTCMinutes() === 0) {
    return startsAt - HORSE_RACE_BETTING_WINDOW_MS;
  }
  // Later races open after the previous scheduled race's full duration and rest,
  // even if that race was cancelled. Cancellation must not silently move the next betting window.
  return startsAt - HORSE_RACE_INTERVAL_MS + HORSE_RACE_DURATION_MS + HORSE_RACE_REST_MS;
}

export function nextHorseRaceStartsAt(now: number): number {
  // KST has no daylight-saving transitions; advance calendar days independently of the host timezone.
  for (let day = 0; day < 4; day++) {
    const next = getHorseRaceDayStarts(now + day * DAY_MS).find((start) => start > now);
    if (next !== undefined) {
      return next;
    }
  }
  throw new Error("No weekday horse race start found");
}

function seededRandom(domain: string, seed: string): () => number {
  let counter = 0;
  return () => {
    const bytes = createHash("sha256")
      .update(JSON.stringify([domain, seed, counter++]))
      .digest();
    // An exact 48-bit integer avoids float rounding to 1, which could skip the final weighted bucket.
    return bytes.readUIntBE(0, 6) / 281_474_976_710_656;
  };
}

export function createRacingHorses(raceId: string, conditionSeed: string): RacingHorse[] {
  // Fixed profile weights own the long-run odds. Private form describes this recorded draw;
  // multiplying weights by form would silently change the promised win rates.
  const conditionRandom = seededRandom(
    `${HORSE_RACING_ALGORITHM_VERSION}:condition`,
    conditionSeed,
  );
  const horses = HORSE_ROSTER.map((horse) => {
    return {
      id: horse.id,
      name: horse.name,
      color: horse.color,
      speed: horse.speed,
      stamina: horse.stamina,
      condition: 0,
      weight: horse.weight,
      winProbability: horse.weight / 100,
      rumor: "",
    };
  });
  const order = drawHorseFinishOrder(horses, conditionSeed);
  const drawRandom = seededRandom(HORSE_RACING_ALGORITHM_VERSION, conditionSeed);
  const scenario = selectHorseRaceScenario(horseRaceScenarios(horses), drawRandom());
  for (const [index, horse] of horses.entries()) {
    const profile = HORSE_ROSTER[index]!;
    const rank = order.indexOf(horse.id);
    const variation = (conditionRandom() - 0.5) * profile.swing * 2;
    const rankCue = horse.id === "4" ? 2 - rank : 5 - rank * 2;
    horse.condition =
      horse.id === HORSE_RACING_JOKER_ID && scenario.jokerForm === "hot"
        ? 90 + Math.floor(conditionRandom() * 11)
        : Math.max(15, Math.min(100, Math.round(profile.form + variation + rankCue)));
    horse.rumor = createHorseRumor(
      raceId,
      horse.id,
      horse.condition,
      conditionSeed,
      profile.stories,
    );
  }
  return horses;
}

function createHorseRumor(
  raceId: string,
  horseId: string,
  condition: number,
  seed: string,
  stories: readonly string[],
): string {
  const random = seededRandom(
    `${HORSE_RACING_ALGORITHM_VERSION}:rumor`,
    JSON.stringify([raceId, horseId, seed]),
  );
  const pick = (values: readonly string[]) => values[Math.floor(random() * values.length)]!;
  const story = pick(stories);
  const scene = pick([
    "마구간 소문통은 오늘도 바쁘네요.",
    "취재진마다 목격담이 조금씩 달라요.",
    "기수는 말을 아꼈고 조교만 씩 웃었대요.",
    "관중석에서는 벌써 응원 소리가 들립니다.",
  ]);
  // The joker's story deliberately ignores latent form: a rumor must not reveal its rare hot branch.
  if (horseId === HORSE_RACING_JOKER_ID) {
    return `${story} ${scene} ${pick(["그래서 오늘도 나도 모르겠다가 공식 입장입니다.", "믿을 건 결승선뿐이라는 말만 남겼대요.", "기수는 이번에도 어깨를 으쓱했대요.", "예측표에는 물음표만 큼지막하게 그렸대요."])}`;
  }
  const observed = condition + (random() - 0.5) * 40;
  const cues =
    observed >= 90
      ? [
          "걸음이 가벼워 보였다는 제보가 있어요.",
          "당근을 더 달라며 발굽을 굴렀대요.",
          "출발 문 쪽으로 자꾸 시선이 갔다네요.",
          "기수의 농담에 귀를 쫑긋 세웠대요.",
        ]
      : observed >= 70
        ? [
            "산책은 평소처럼 마쳤다는 이야기가 들려요.",
            "기수와 호흡을 맞추다가 건초도 챙겼대요.",
            "큰 소란 없이 준비 운동을 마쳤대요.",
            "관중 소리에 잠깐 고개를 들었다네요.",
          ]
        : [
            "아침에는 유난히 말수가 적었다는 소문이에요.",
            "건초를 씹으며 잠깐 멍을 때렸대요.",
            "산책 중 하품을 했다는 목격담이 있어요.",
            "기수가 오늘은 응원을 더 부탁한대요.",
          ];
  return `${story} ${scene} ${pick(cues)} ${pick(["소문은 소문, 결승선은 직접 봐야죠.", "취재 수첩도 정답지는 아니랍니다.", "마지막 직선까지는 아무도 장담 못 한대요.", "당근 담당자의 말이라 조금 과장됐을 수도 있어요."])}`;
}

function canonicalHorses(horses: RacingHorse[]): RacingHorse[] {
  return horses.toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function horseRaceCommitment(raceId: string, horses: RacingHorse[], seed: string): string {
  const roster = canonicalHorses(horses).map((horse) => [
    horse.id,
    horse.name,
    horse.color,
    horse.speed,
    horse.stamina,
    horse.condition,
    horse.weight,
    horse.winProbability,
    horse.rumor,
  ]);
  return createHash("sha256")
    .update(JSON.stringify([HORSE_RACING_ALGORITHM_VERSION, raceId, roster, seed]))
    .digest("hex");
}

export function drawHorseFinishOrder(horses: RacingHorse[], seed: string): string[] {
  const random = seededRandom(HORSE_RACING_ALGORITHM_VERSION, seed);
  // Counter 0 selects hidden form; counters 1 onward draw a full weighted permutation without forced ranks.
  const remaining = selectHorseRaceScenario(
    horseRaceScenarios(canonicalHorses(horses)),
    random(),
  ).horses;
  const order: string[] = [];
  while (remaining.length > 0) {
    const total = remaining.reduce((sum, horse) => sum + horse.weight, 0);
    let draw = random() * total;
    const index = remaining.findIndex((horse) => {
      draw -= horse.weight;
      return draw < 0;
    });
    order.push(...remaining.splice(index, 1).map((horse) => horse.id));
  }
  return order;
}

export function horseRacePositions(
  horses: RacingHorse[],
  finishOrder: string[],
  seed: string,
  elapsedMs: number,
): HorseRacePosition[] {
  return horses.map((horse) => {
    const rank = finishOrder.indexOf(horse.id);
    const finishAt = HORSE_RACE_DURATION_MS - 2_500 + (2_500 * rank) / (horses.length - 1);
    const progress = Math.max(0, Math.min(1, elapsedMs / finishAt));
    const random = seededRandom(HORSE_RACING_ANIMATION_VERSION, JSON.stringify([seed, horse.id]));
    const segments = 12;
    const pace = Array.from({ length: segments }, (_, index) => {
      // Adapted from Horse Chaos: small speed nudge, seeded velocity noise and fatigue after 60%.
      // Normalize positive segment distances so animation cannot change the independently drawn finish order.
      const statNudge = (horse.speed - 50) / 50 / 3;
      const fatigue = Math.max(0, index / segments - 0.6) * (1 - horse.stamina / 100) * 1.5;
      const lateForm = (Math.max(0, index / segments - 0.5) * horse.condition) / 100;
      return (2.5 + statNudge + (random() - 0.5) * 2 + lateForm) * (1 - fatigue);
    });
    const total = pace.reduce((sum, value) => sum + value, 0);
    const distance = pace.reduce(
      (sum, value, index) => sum + value * Math.max(0, Math.min(1, progress * segments - index)),
      0,
    );
    return {
      horseId: horse.id,
      position: progress === 1 ? 100 : (distance / total) * 100,
      ...(progress === 1 ? { finishPlace: rank + 1 } : {}),
    };
  });
}
