import heroDocument from "./login-hero.template.html?raw";

const HERO_REFERENCE_WIDTH = 720;
const HERO_REFERENCE_HEIGHT = 900;
const HERO_MAX_RENDERED_WIDTH = 560;

export function installPlatformClawLoginHero(root: HTMLElement): void {
  root.setAttribute("aria-hidden", "true");
  const documentTemplate = new DOMParser().parseFromString(heroDocument, "text/html");
  const sourceStyle = documentTemplate.querySelector("style");
  const sourceHero = documentTemplate.querySelector<HTMLElement>(".hero");
  if (!sourceStyle || !sourceHero) {
    throw new Error("PlatformClaw login hero template is invalid");
  }

  const shadow = root.shadowRoot ?? root.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  // The supplied standalone document uses :root. Inside the component, the
  // host owns those same light/dark tokens without leaking into upstream UI.
  style.textContent = sourceStyle.textContent.replaceAll(":root", ":host");
  const integrationStyle = document.createElement("style");
  integrationStyle.textContent = `
    :host {
      --hero-rendered-height: 700px;
      --hero-rendered-width: 560px;
      --hero-scale: 0.7777778;
      display: block;
      width: 100%;
      height: var(--hero-rendered-height);
      min-width: 0;
    }
    .login-hero__viewport {
      width: var(--hero-rendered-width);
      height: var(--hero-rendered-height);
      margin-inline: auto;
      overflow: hidden;
      border-radius: 16px;
      box-shadow: 0 12px 28px rgba(20, 20, 19, 0.09);
    }
    .hero {
      width: 720px;
      height: 900px;
      border-radius: 0;
      box-shadow: none;
      transform: scale(var(--hero-scale));
      transform-origin: top left;
    }
    .task, .scene, .board-result { border-radius: 12px; }
    .composer { border-radius: 12px; }
    @media (prefers-color-scheme: dark) {
      .login-hero__viewport { box-shadow: 0 12px 28px rgba(0, 0, 0, 0.24); }
    }
  `;
  const viewport = document.createElement("div");
  viewport.className = "login-hero__viewport";
  viewport.append(sourceHero);
  shadow.replaceChildren(style, integrationStyle, viewport);

  const syncSize = () => {
    const availableWidth = root.clientWidth;
    if (availableWidth <= 0) {
      return;
    }
    const renderedWidth = Math.min(availableWidth, HERO_MAX_RENDERED_WIDTH);
    const scale = renderedWidth / HERO_REFERENCE_WIDTH;
    root.style.setProperty("--hero-scale", String(scale));
    root.style.setProperty("--hero-rendered-width", `${renderedWidth}px`);
    root.style.setProperty("--hero-rendered-height", `${HERO_REFERENCE_HEIGHT * scale}px`);
  };
  syncSize();
  if (typeof ResizeObserver === "undefined") {
    return;
  }
  const observer = new ResizeObserver(syncSize);
  observer.observe(root);
}
