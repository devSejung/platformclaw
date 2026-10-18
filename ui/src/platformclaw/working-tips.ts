import type { RouteId } from "../app-route-paths.ts";
import type { ApplicationContext } from "../app/context.ts";
import { fnv1aUtf16 } from "../lib/fnv1a.ts";
import { platformClawT as t } from "./i18n.ts";

const TIPS: readonly { key: string; route?: RouteId }[] = [
  { key: "request" },
  { key: "newChat", route: "new-session" },
  { key: "history", route: "sessions" },
  { key: "skillHub", route: "skill-hub" },
  { key: "createSkill", route: "skills" },
  { key: "workshop", route: "skill-workshop" },
  { key: "workLocation" },
  { key: "memory", route: "memory" },
  { key: "automation", route: "cron" },
  { key: "help" },
  { key: "space", route: "spaces" },
  { key: "wiki", route: "memory" },
  { key: "personalWiki", route: "memory" },
  { key: "sharedWiki", route: "memory" },
  { key: "aiReference", route: "memory" },
];
const ASIDES = ["gpu", "support"] as const;

export function createPlatformClawWorkingTip(
  enabledRoutes: readonly RouteId[],
): NonNullable<ApplicationContext["chatWorkingTip"]> {
  const tips = TIPS.filter((tip) => !tip.route || enabledRoutes.includes(tip.route)).map(
    (tip) => tip.key,
  );
  return (seed, rotation) => {
    // Keep jokes to every eighth slot. The other slots walk all eligible tips
    // before repeating, even when route filtering leaves a non-prime count.
    const aside = rotation % 8 === 7;
    const keys = aside ? ASIDES : tips;
    const offset = fnv1aUtf16(`${seed}:${aside ? "aside" : "tip"}`) % keys.length;
    const step = aside ? Math.floor(rotation / 8) : rotation - Math.floor((rotation + 1) / 8);
    return t(`platformClaw.waitingTips.${keys[(offset + step) % keys.length]}`);
  };
}
