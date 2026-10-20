import heroDocument from "./login-hero.template.html?raw";

export function installPlatformClawLoginHero(root: HTMLElement): void {
  root.setAttribute("aria-hidden", "true");
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
}
