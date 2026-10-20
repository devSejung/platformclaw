import { LOCALE_STORAGE_KEY } from "../i18n/lib/locale-preferences.ts";
import {
  applyPlatformClawLoginCopy,
  platformClawLoginT as t,
  type LoginCopyKey,
} from "./login-copy.ts";
import { installPlatformClawLoginGuide } from "./login-guide.ts";
import { installPlatformClawLoginHero } from "./login-hero.ts";
import { installPlatformClawLoginMascot } from "./login-mascot.ts";
import {
  PLATFORMCLAW_ADSSO_PATH,
  PLATFORMCLAW_LOGIN_API_PATH,
  PLATFORMCLAW_SESSION_API_PATH,
  PLATFORMCLAW_SESSION_CHECK_TIMEOUT_MS,
  resolvePlatformClawReturnTo,
} from "./web-contract.ts";

type LoginPhase = "checking" | "ready" | "submitting";
type LoginError = { key: LoginCopyKey } | { message: string };

type LoginElements = {
  hero: HTMLElement;
  mascot: HTMLElement;
  form: HTMLFormElement;
  identifier: HTMLInputElement;
  secretInput: HTMLInputElement;
  submit: HTMLButtonElement;
  ssoLink: HTMLAnchorElement;
  error: HTMLElement;
  status: HTMLElement;
};

type PlatformClawLoginOptions = {
  fetchImpl?: typeof fetch;
  location?: Pick<Location, "href" | "origin">;
  navigate?: (path: string) => void;
  sessionCheckTimeoutMs?: number;
};

function requiredElement<T extends Element>(
  root: ParentNode,
  selector: string,
  constructor: new () => T,
): T {
  const element = root.querySelector(selector);
  if (!(element instanceof constructor)) {
    throw new Error(`PlatformClaw login element missing: ${selector}`);
  }
  return element;
}

function readElements(root: ParentNode): LoginElements {
  return {
    hero: requiredElement(root, "[data-login-hero]", HTMLElement),
    mascot: requiredElement(root, "[data-login-mascot]", HTMLElement),
    form: requiredElement(root, "[data-login-form]", HTMLFormElement),
    identifier: requiredElement(root, 'input[name="identifier"]', HTMLInputElement),
    secretInput: requiredElement(root, 'input[name="password"]', HTMLInputElement),
    submit: requiredElement(root, 'button[type="submit"]', HTMLButtonElement),
    ssoLink: requiredElement(root, "[data-login-adsso]", HTMLAnchorElement),
    error: requiredElement(root, "[data-login-error]", HTMLElement),
    status: requiredElement(root, "[data-login-status]", HTMLElement),
  };
}

function isAuthenticated(payload: unknown): boolean {
  return Boolean(
    payload &&
    typeof payload === "object" &&
    "authenticated" in payload &&
    payload.authenticated === true,
  );
}

function readMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || !("message" in payload)) {
    return null;
  }
  return typeof payload.message === "string" ? payload.message.trim() || null : null;
}

function loginFailureMessage(status: number, payload: unknown): LoginError {
  if (status === 401) {
    return { key: "invalidCredentials" };
  }
  if (status === 429) {
    return { key: "rateLimited" };
  }
  if (status === 403) {
    return { key: "forbidden" };
  }
  if (status === 409) {
    return { key: "sessionLimit" };
  }
  const message = readMessage(payload);
  return message ? { message } : { key: "loginFailed" };
}

export class PlatformClawLoginController {
  private readonly elements: LoginElements;
  private readonly fetchImpl: typeof fetch;
  private readonly returnTo: string;
  private readonly navigate: (path: string) => void;
  private readonly sessionCheckTimeoutMs: number;
  private phase: LoginPhase = "checking";
  private initialError?: LoginCopyKey;
  private error: LoginError | null = null;
  private stopHero?: () => void;
  private stopMascot?: () => void;
  private readonly stopVisuals = (event?: PageTransitionEvent) => {
    if (event?.persisted) {
      return;
    }
    this.stopHero?.();
    this.stopMascot?.();
    this.stopHero = undefined;
    this.stopMascot = undefined;
  };
  private readonly refreshLocale = (event: Event) => {
    if (event instanceof StorageEvent && event.key !== null && event.key !== LOCALE_STORAGE_KEY) {
      return;
    }
    applyPlatformClawLoginCopy(this.elements.form.ownerDocument);
    if (this.elements.hero.shadowRoot) {
      // Update copy in place: a language change must preserve ambient motion,
      // focus, entered credentials, and the current authentication phase.
      applyPlatformClawLoginCopy(this.elements.hero.shadowRoot);
    }
    this.render();
  };

  constructor(root: ParentNode, options: PlatformClawLoginOptions = {}) {
    this.elements = readElements(root);
    const fetchImpl = options.fetchImpl;
    this.fetchImpl = fetchImpl
      ? (input, init) => fetchImpl(input, init)
      : (input, init) => globalThis.fetch(input, init);
    const location = options.location ?? window.location;
    this.returnTo = resolvePlatformClawReturnTo(location);
    const loginUrl = new URL(location.href);
    if (loginUrl.searchParams.get("adssoError") === "unavailable") {
      this.initialError = "adssoUnavailable";
    }
    const ssoUrl = new URL(PLATFORMCLAW_ADSSO_PATH, location.origin);
    ssoUrl.searchParams.set("returnTo", this.returnTo);
    this.elements.ssoLink.href = `${ssoUrl.pathname}${ssoUrl.search}`;
    this.navigate = options.navigate ?? ((path) => window.location.assign(path));
    this.sessionCheckTimeoutMs =
      options.sessionCheckTimeoutMs ?? PLATFORMCLAW_SESSION_CHECK_TIMEOUT_MS;
  }

  start(): void {
    applyPlatformClawLoginCopy(this.elements.form.ownerDocument);
    const view = this.elements.form.ownerDocument.defaultView;
    view?.addEventListener("storage", this.refreshLocale);
    view?.addEventListener("languagechange", this.refreshLocale);
    view?.addEventListener("pagehide", this.stopVisuals);
    installPlatformClawLoginGuide(this.elements.form.ownerDocument);
    this.stopHero = installPlatformClawLoginHero(this.elements.hero);
    this.stopMascot = installPlatformClawLoginMascot(
      this.elements.mascot,
      this.elements.identifier,
      this.elements.secretInput,
    );
    this.elements.form.addEventListener("submit", (event) => {
      void this.submit(event);
    });
    this.render();
    void this.checkSession();
  }

  dispose(): void {
    this.stopVisuals();
    const view = this.elements.form.ownerDocument.defaultView;
    view?.removeEventListener("storage", this.refreshLocale);
    view?.removeEventListener("languagechange", this.refreshLocale);
    view?.removeEventListener("pagehide", this.stopVisuals);
  }

  private render(error: LoginError | null = this.error): void {
    this.error = error;
    const busy = this.phase !== "ready";
    this.elements.identifier.disabled = busy;
    this.elements.secretInput.disabled = busy;
    this.elements.submit.disabled = busy;
    const submitKey =
      this.phase === "checking" ? "checking" : this.phase === "submitting" ? "signingIn" : "signIn";
    this.elements.submit.dataset.loginCopy = submitKey;
    this.elements.submit.textContent = t(submitKey);
    if (this.phase === "checking") {
      this.elements.status.dataset.loginCopy = "checkingStatus";
      this.elements.status.textContent = t("checkingStatus");
    } else {
      delete this.elements.status.dataset.loginCopy;
      this.elements.status.textContent = "";
    }
    this.elements.error.hidden = !error;
    this.elements.error.textContent = error ? ("key" in error ? t(error.key) : error.message) : "";
  }

  private async checkSession(): Promise<void> {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), this.sessionCheckTimeoutMs);
    try {
      const response = await this.fetchImpl(PLATFORMCLAW_SESSION_API_PATH, {
        headers: { Accept: "application/json" },
        credentials: "include",
        signal: controller.signal,
      });
      if (response.ok && isAuthenticated(await response.json())) {
        this.navigate(this.returnTo);
        return;
      }
    } catch {
      // A temporary bootstrap failure must not prevent a fresh sign-in attempt.
    } finally {
      window.clearTimeout(timeout);
    }
    this.phase = "ready";
    const initialError = this.initialError;
    this.initialError = undefined;
    this.render(initialError ? { key: initialError } : null);
  }

  private async submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (this.phase !== "ready" || !this.elements.form.reportValidity()) {
      return;
    }
    this.phase = "submitting";
    this.render(null);
    try {
      const response = await this.fetchImpl(PLATFORMCLAW_LOGIN_API_PATH, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          identifier: this.elements.identifier.value.trim(),
          password: this.elements.secretInput.value,
        }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok || !isAuthenticated(payload)) {
        this.elements.secretInput.value = "";
        this.phase = "ready";
        this.render(loginFailureMessage(response.status, payload));
        this.elements.secretInput.focus();
        return;
      }
      this.navigate(this.returnTo);
    } catch {
      this.phase = "ready";
      this.render({ key: "networkUnavailable" });
    }
  }
}

const loginRoot = document.querySelector("[data-platformclaw-login]");
if (loginRoot) {
  new PlatformClawLoginController(loginRoot).start();
}
