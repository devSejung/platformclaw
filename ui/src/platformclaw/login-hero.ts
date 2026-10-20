import { applyPlatformClawLoginCopy } from "./login-copy.ts";
import heroDocument from "./login-hero.template.html?raw";

export function installPlatformClawLoginHero(root: HTMLElement): () => void {
  // The SVG remains decorative; the motion control and marketing copy are accessible.
  root.removeAttribute("aria-hidden");
  for (const attribute of ["data-motion-ready", "data-motion-paused", "data-ambient-paused"]) {
    root.removeAttribute(attribute);
  }
  const template = new DOMParser().parseFromString(heroDocument, "text/html");
  const style = template.querySelector("style");
  const hero = template.querySelector<HTMLElement>(".hero");
  if (!style || !hero) {
    throw new Error("PlatformClaw login hero template is invalid");
  }
  // Inherit the form's theme through the shadow boundary instead of maintaining
  // an independent palette or OS preference resolver for the illustration.
  const shadow = root.shadowRoot ?? root.attachShadow({ mode: "open" });
  shadow.replaceChildren(style, hero);
  applyPlatformClawLoginCopy(shadow);

  const button = shadow.querySelector<HTMLButtonElement>("[data-motion-toggle]")!;
  const document = root.ownerDocument;
  const form = root.closest(".login-page")?.querySelector("form");
  const reducedMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");
  const abort = new AbortController();
  const { signal } = abort;
  let paused = false;
  let ready = false;
  let flows: Array<{ packet: SVGCircleElement; animation: Animation }> = [];

  const clearFlows = () => {
    for (const { packet, animation } of flows) {
      animation.cancel();
      packet.remove();
    }
    flows = [];
  };

  const syncPlayback = () => {
    if (signal.aborted) {
      return;
    }
    const pauseAll = paused || document.hidden;
    const pauseAmbient = pauseAll || Boolean(form?.contains(document.activeElement));
    root.toggleAttribute("data-motion-paused", pauseAll);
    root.toggleAttribute("data-ambient-paused", pauseAmbient);
    for (const { animation } of flows) {
      if (pauseAmbient) {
        animation.pause();
      } else {
        animation.play();
      }
    }
  };

  const startFlows = () => {
    clearFlows();
    if (reducedMotion?.matches) {
      return;
    }
    flows = Array.from(shadow.querySelectorAll<SVGPathElement>(".connector path")).map(
      (path, index) => {
        const packet = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        packet.setAttribute("class", "flow-packet");
        packet.setAttribute("r", "2.5");
        const start = path.getPointAtLength(0);
        packet.setAttribute("cx", String(start.x));
        packet.setAttribute("cy", String(start.y));
        path.after(packet);
        const length = path.getTotalLength();
        // Sample the authored connector once, keeping its rounded corners and endpoints
        // canonical. Only transform/opacity animate; there is no measurement or rAF loop.
        const keyframes = Array.from({ length: 49 }, (_, frame): Keyframe => {
          const progress = frame / 48;
          const point = path.getPointAtLength(length * progress);
          return {
            transform: `translate(${point.x - start.x}px, ${point.y - start.y}px)`,
            opacity: Math.min(progress / 0.12, 1, (1 - progress) / 0.16) * 0.72,
          };
        });
        const animation = packet.animate(keyframes, {
          duration: 6_100 + index * 900,
          delay: index * 450,
          iterations: Infinity,
          easing: "linear",
        });
        return { packet, animation };
      },
    );
    syncPlayback();
  };

  hero.querySelector(".complete")!.addEventListener(
    "animationend",
    () => {
      // Record completion at the actual intro boundary. Focusing or translating the
      // page can pause idle motion without restarting the explanatory entrance.
      ready = true;
      root.setAttribute("data-motion-ready", "");
      startFlows();
    },
    { once: true, signal },
  );
  button.addEventListener(
    "click",
    () => {
      paused = !paused;
      button.setAttribute("aria-pressed", String(paused));
      button.setAttribute(
        "data-login-copy-aria-label",
        paused ? "resumeAnimation" : "pauseAnimation",
      );
      applyPlatformClawLoginCopy(shadow);
      syncPlayback();
    },
    { signal },
  );
  document.addEventListener("focusin", syncPlayback, { signal });
  document.addEventListener("focusout", () => queueMicrotask(syncPlayback), { signal });
  document.addEventListener("visibilitychange", syncPlayback, { signal });
  reducedMotion?.addEventListener("change", () => ready && startFlows(), { signal });
  syncPlayback();

  return () => {
    abort.abort();
    clearFlows();
    root.setAttribute("data-motion-paused", "");
  };
}
