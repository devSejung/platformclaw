import heroDocument from "./login-hero.template.html?raw";

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
    :host { container-type: inline-size; display: block; width: 100%; min-width: 0; }
    .hero {
      width: min(100%, 35rem);
      margin-inline: auto;
      border-radius: 16px;
      box-shadow: 0 12px 28px rgba(20, 20, 19, 0.09);
    }
    .task, .scene, .board-result { border-radius: 12px; }
    .composer { border-radius: 12px; }
    @media (prefers-color-scheme: dark) {
      .hero { box-shadow: 0 12px 28px rgba(0, 0, 0, 0.24); }
    }
    @container (max-width: 420px) {
      .topbar { gap: 10px; }
      .brand { font-size: 20px; }
      .brand small { margin-top: 3px; font-size: 8px; }
      .badge { gap: 6px; padding: 8px 10px; font-size: 7px; }
      .badge b { width: 6px; height: 6px; }
      .task { padding: 10px 12px; }
      .task-meta { font-size: 7px; }
      .task-title { margin-top: 4px; font-size: 20px; }
      .task-status { top: 10px; right: 10px; padding: 8px 10px; font-size: 7px; }
      .layer { padding: 18px; }
      h1 { font-size: 24px; }
    }
  `;
  shadow.replaceChildren(style, integrationStyle, sourceHero);
}
