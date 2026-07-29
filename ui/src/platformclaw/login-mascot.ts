import mascotSvg from "./platformclaw-pixel.svg?raw";

const LOGICAL_PIXEL_PX = 2;
const BODY_RANGE_PX = 32;
const EYE_RANGE_X = 3;
const EYE_RANGE_Y = 2;
const BLINK_MIN_MS = 2_800;
const BLINK_JITTER_MS = 2_400;
const BLINK_DURATION_MS = 140;

type MascotMode = "idle" | "account" | "password";

type MascotElements = {
  root: HTMLElement;
  runner: HTMLElement;
  svg: SVGSVGElement;
  identifier: HTMLInputElement;
  secretInput: HTMLInputElement;
  mirror: HTMLSpanElement;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function snapCssPixel(value: number): number {
  return Math.round(value / LOGICAL_PIXEL_PX) * LOGICAL_PIXEL_PX;
}

function setMode(elements: MascotElements, mode: MascotMode): void {
  elements.root.dataset.loginMascotMode = mode;
  elements.root.style.setProperty("--eye-open", mode === "password" ? "0.25" : "1");
}

function setLook(elements: MascotElements, clientX: number, clientY: number): void {
  const mascot = elements.svg.getBoundingClientRect();
  const centerX = mascot.left + mascot.width / 2;
  const centerY = mascot.top + mascot.height / 2;
  const normalizedX = clamp((clientX - centerX) / Math.max(mascot.width / 2, 1), -1, 1);
  const normalizedY = clamp((clientY - centerY) / Math.max(mascot.height / 2, 1), -1, 1);
  elements.root.style.setProperty("--eye-x", `${Math.round(normalizedX * EYE_RANGE_X)}px`);
  elements.root.style.setProperty("--eye-y", `${Math.round(normalizedY * EYE_RANGE_Y)}px`);
}

function setBodyPosition(elements: MascotElements, clientX: number): void {
  const viewportCenter = window.innerWidth / 2;
  const normalizedX = clamp((clientX - viewportCenter) / Math.max(viewportCenter, 1), -1, 1);
  const nextPosition = `${snapCssPixel(normalizedX * BODY_RANGE_PX)}px`;
  if (elements.root.style.getPropertyValue("--mascot-x") === nextPosition) {
    return;
  }
  elements.root.style.setProperty("--mascot-x", nextPosition);
  elements.runner.classList.add("is-waddling");
}

function resetPose(elements: MascotElements): void {
  elements.root.style.setProperty("--mascot-x", "0px");
  elements.root.style.setProperty("--eye-x", "0px");
  elements.root.style.setProperty("--eye-y", "0px");
}

function syncMirrorTypography(input: HTMLInputElement, mirror: HTMLElement): void {
  const style = window.getComputedStyle(input);
  mirror.style.font = style.font;
  mirror.style.fontKerning = style.fontKerning;
  mirror.style.letterSpacing = style.letterSpacing;
  mirror.style.textTransform = style.textTransform;
}

function caretClientX(input: HTMLInputElement, mirror: HTMLSpanElement): number {
  syncMirrorTypography(input, mirror);
  const selection = input.selectionStart ?? input.value.length;
  mirror.textContent = input.value.slice(0, selection) || " ";
  const inputRect = input.getBoundingClientRect();
  return clamp(
    inputRect.left +
      input.clientLeft +
      14 +
      mirror.getBoundingClientRect().width -
      input.scrollLeft,
    inputRect.left + 10,
    inputRect.right - 10,
  );
}

function mountMascot(root: HTMLElement): { runner: HTMLElement; svg: SVGSVGElement } {
  const runner = document.createElement("div");
  runner.className = "login-mascot__runner";
  const template = document.createElement("template");
  // Compile-time asset only: this never contains runtime or user-provided markup.
  template.innerHTML = mascotSvg.trim();
  const svg = template.content.querySelector("svg");
  if (!(svg instanceof SVGSVGElement)) {
    throw new Error("PlatformClaw mascot asset is invalid");
  }
  svg.removeAttribute("width");
  svg.removeAttribute("height");
  svg.removeAttribute("role");
  svg.removeAttribute("aria-labelledby");
  svg.querySelector("title")?.remove();
  svg.querySelector("desc")?.remove();
  svg.classList.add("login-mascot__svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  runner.append(svg);
  root.replaceChildren(runner);
  return { runner, svg };
}

export function installPlatformClawLoginMascot(
  root: HTMLElement,
  identifier: HTMLInputElement,
  secretInput: HTMLInputElement,
): () => void {
  const { runner, svg } = mountMascot(root);
  const mirror = document.createElement("span");
  mirror.className = "login-mascot__mirror";
  mirror.setAttribute("aria-hidden", "true");
  root.append(mirror);
  const elements: MascotElements = { root, runner, svg, identifier, secretInput, mirror };
  const abort = new AbortController();
  const { signal } = abort;
  let caretFrame = 0;
  let pointerFrame = 0;
  let pendingPointer: { x: number; y: number } | null = null;
  let blinkTimeout = 0;
  let blinkEndTimeout = 0;

  const updateCaret = () => {
    window.cancelAnimationFrame(caretFrame);
    caretFrame = window.requestAnimationFrame(() => {
      if (document.activeElement !== identifier) {
        return;
      }
      const x = caretClientX(identifier, mirror);
      const rect = identifier.getBoundingClientRect();
      setBodyPosition(elements, x);
      setLook(elements, x, rect.top + rect.height / 2);
    });
  };

  runner.addEventListener("animationend", () => runner.classList.remove("is-waddling"), {
    signal,
  });

  const scheduleBlink = () => {
    blinkTimeout = window.setTimeout(
      () => {
        if (root.dataset.loginMascotMode !== "password") {
          root.classList.add("is-blinking");
          blinkEndTimeout = window.setTimeout(
            () => root.classList.remove("is-blinking"),
            BLINK_DURATION_MS,
          );
        }
        scheduleBlink();
      },
      BLINK_MIN_MS + Math.random() * BLINK_JITTER_MS,
    );
  };

  window.addEventListener(
    "pointermove",
    (event) => {
      if (document.activeElement === identifier || document.activeElement === secretInput) {
        return;
      }
      pendingPointer = { x: event.clientX, y: event.clientY };
      if (pointerFrame) {
        return;
      }
      pointerFrame = window.requestAnimationFrame(() => {
        pointerFrame = 0;
        const pointer = pendingPointer;
        pendingPointer = null;
        if (!pointer) {
          return;
        }
        setMode(elements, "idle");
        setBodyPosition(elements, pointer.x);
        setLook(elements, pointer.x, pointer.y);
      });
    },
    { signal, passive: true },
  );
  document.addEventListener(
    "pointerleave",
    () => {
      if (document.activeElement !== identifier && document.activeElement !== secretInput) {
        resetPose(elements);
      }
    },
    { signal },
  );
  window.addEventListener("resize", () => resetPose(elements), { signal, passive: true });

  identifier.addEventListener(
    "focus",
    () => {
      setMode(elements, "account");
      updateCaret();
    },
    { signal },
  );
  for (const eventName of [
    "input",
    "keyup",
    "click",
    "select",
    "compositionupdate",
    "compositionend",
  ] as const) {
    identifier.addEventListener(eventName, updateCaret, { signal });
  }
  identifier.addEventListener(
    "blur",
    () => {
      if (document.activeElement !== secretInput) {
        setMode(elements, "idle");
        resetPose(elements);
      }
    },
    { signal },
  );
  secretInput.addEventListener(
    "focus",
    () => {
      setMode(elements, "password");
      root.style.setProperty("--eye-x", "0px");
      root.style.setProperty("--eye-y", "0px");
    },
    { signal },
  );
  secretInput.addEventListener(
    "blur",
    () => {
      setMode(elements, "idle");
      resetPose(elements);
    },
    { signal },
  );

  setMode(elements, "idle");
  resetPose(elements);
  scheduleBlink();

  return () => {
    abort.abort();
    window.cancelAnimationFrame(caretFrame);
    window.cancelAnimationFrame(pointerFrame);
    window.clearTimeout(blinkTimeout);
    window.clearTimeout(blinkEndTimeout);
    root.replaceChildren();
  };
}
