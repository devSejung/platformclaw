import type { Locator, Page } from "playwright";

export async function denseSessionOverlapCounts(page: Page): Promise<number[]> {
  await page.locator(".sidebar-shell__body").evaluate((body) => {
    const denseSessions = document.createElement("section");
    for (let index = 0; index < 24; index += 1) {
      const row = document.createElement("a");
      row.className = "sidebar-recent-session__link";
      row.textContent = `dense session ${index + 1}`;
      row.style.display = "block";
      row.style.height = "28px";
      denseSessions.append(row);
    }
    body.append(denseSessions);
  });
  const counts: number[] = [];
  for (const ratio of [0, 0.5, 1]) {
    await page.locator(".sidebar-shell__body").evaluate((body, scrollRatio) => {
      body.scrollTop = (body.scrollHeight - body.clientHeight) * scrollRatio;
    }, ratio);
    counts.push(
      await page.locator(".sidebar-recent-session__link").evaluateAll(
        (rows) =>
          rows.filter((row) => {
            const bounds = row.getBoundingClientRect();
            const scroller = document
              .querySelector<HTMLElement>(".sidebar-shell__body")!
              .getBoundingClientRect();
            const visibleBounds = {
              bottom: Math.min(bounds.bottom, scroller.bottom),
              left: Math.max(bounds.left, scroller.left),
              right: Math.min(bounds.right, scroller.right),
              top: Math.max(bounds.top, scroller.top),
            };
            if (
              visibleBounds.bottom <= visibleBounds.top ||
              visibleBounds.right <= visibleBounds.left
            ) {
              return false;
            }
            const overlaps = (selector: string) => {
              const other = document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
              return (
                visibleBounds.left < other.right &&
                visibleBounds.right > other.left &&
                visibleBounds.top < other.bottom &&
                visibleBounds.bottom > other.top
              );
            };
            return [
              ".platformclaw-easter-egg__player",
              ".platformclaw-easter-egg__target",
              ".platformclaw-easter-egg__score",
            ].some(overlaps);
          }).length,
      ),
    );
  }
  return counts;
}

export function readBatterPose(game: Locator) {
  return game.evaluate((root) => {
    const snapshot = (selector: string) => {
      const element = root.querySelector<HTMLElement>(selector);
      if (!element) {
        throw new Error(`missing ${selector}`);
      }
      const bounds = element.getBoundingClientRect();
      return {
        bottom: bounds.bottom,
        left: bounds.left,
        right: bounds.right,
        top: bounds.top,
        transform: getComputedStyle(element).transform,
      };
    };
    return {
      arm: snapshot(".platformclaw-easter-egg__player .platformclaw-easter-egg__figure-arm-front"),
      bat: snapshot(".platformclaw-easter-egg__bat"),
      label: snapshot(".platformclaw-easter-egg__player .platformclaw-easter-egg__figure-label"),
      leg: snapshot(".platformclaw-easter-egg__player .platformclaw-easter-egg__figure-leg-front"),
      player: snapshot(".platformclaw-easter-egg__player"),
      torso: snapshot(".platformclaw-easter-egg__player .platformclaw-easter-egg__figure-torso"),
    };
  });
}

export function readPitchTiming(host: Locator) {
  return host.evaluate((element) => {
    const pitch = (
      element as HTMLElement & {
        pitch?: { idealContactTimeMs: number; speedKph: number };
      }
    ).pitch;
    if (!pitch) {
      throw new Error("missing active pitch");
    }
    return pitch;
  });
}

function batterPoseDrift(
  reference: Awaited<ReturnType<typeof readBatterPose>>,
  sample: Awaited<ReturnType<typeof readBatterPose>>,
): number[] {
  return (["player", "torso", "leg", "label"] as const).flatMap((part) =>
    (["bottom", "left", "right", "top"] as const).map((edge) =>
      Math.abs(sample[part][edge] - reference[part][edge]),
    ),
  );
}

export function summarizeBatterMotion(
  idle: Awaited<ReturnType<typeof readBatterPose>>,
  contact: Awaited<ReturnType<typeof readBatterPose>>,
  follow: Awaited<ReturnType<typeof readBatterPose>>,
) {
  return {
    contactChanged:
      contact.bat.transform !== idle.bat.transform && contact.arm.transform !== idle.arm.transform,
    contactPlanted: Math.max(...batterPoseDrift(idle, contact)) <= 1,
    followChanged:
      follow.bat.transform !== idle.bat.transform && follow.arm.transform !== idle.arm.transform,
    followPlanted: Math.max(...batterPoseDrift(idle, follow)) <= 1,
  };
}

export function readBaseballPaint(game: Locator) {
  return game.evaluate((root) => ({
    projectile: getComputedStyle(
      root.querySelector<HTMLElement>(".platformclaw-easter-egg__projectile")!,
    ).backgroundColor,
    trail: [
      ...new Set(
        Array.from(root.querySelectorAll<HTMLElement>(".platformclaw-easter-egg__trail-dot")).map(
          (element) => getComputedStyle(element).backgroundColor,
        ),
      ),
    ],
  }));
}

export async function setThemeMode(page: Page, mode: "dark" | "light"): Promise<void> {
  await page.evaluate((nextMode) => {
    document.documentElement.dataset.theme =
      nextMode === "dark" ? "platformclaw" : "platformclaw-light";
    document.documentElement.dataset.themeMode = nextMode;
    document.documentElement.dataset.themeResolved = nextMode;
    document.documentElement.classList.toggle("wa-dark", nextMode === "dark");
    document.documentElement.classList.toggle("wa-light", nextMode === "light");
    document.documentElement.style.colorScheme = nextMode;
  }, mode);
}
