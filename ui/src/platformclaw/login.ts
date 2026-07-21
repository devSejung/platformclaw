import {
  PLATFORMCLAW_LOGIN_API_PATH,
  PLATFORMCLAW_SESSION_API_PATH,
  resolvePlatformClawReturnTo,
} from "./web-contract.ts";

const SESSION_CHECK_TIMEOUT_MS = 5_000;
type LoginPhase = "checking" | "ready" | "submitting";

type LoginElements = {
  form: HTMLFormElement;
  identifier: HTMLInputElement;
  secretInput: HTMLInputElement;
  submit: HTMLButtonElement;
  error: HTMLElement;
  status: HTMLElement;
};

export type PlatformClawLoginOptions = {
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
    form: requiredElement(root, "[data-login-form]", HTMLFormElement),
    identifier: requiredElement(root, 'input[name="identifier"]', HTMLInputElement),
    secretInput: requiredElement(root, 'input[name="password"]', HTMLInputElement),
    submit: requiredElement(root, 'button[type="submit"]', HTMLButtonElement),
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

function loginFailureMessage(status: number, payload: unknown): string {
  if (status === 401) {
    return "아이디 또는 비밀번호를 확인해 주세요.";
  }
  if (status === 429) {
    return "로그인 시도가 많습니다. 잠시 후 다시 시도해 주세요.";
  }
  if (status === 403) {
    return "현재 계정으로는 접속할 수 없습니다. 관리자에게 문의해 주세요.";
  }
  if (status === 409) {
    return "사용 가능한 로그인 세션 수를 초과했습니다. 관리자에게 문의해 주세요.";
  }
  return readMessage(payload) ?? "로그인하지 못했습니다. 잠시 후 다시 시도해 주세요.";
}

export class PlatformClawLoginController {
  private readonly elements: LoginElements;
  private readonly fetchImpl: typeof fetch;
  private readonly returnTo: string;
  private readonly navigate: (path: string) => void;
  private readonly sessionCheckTimeoutMs: number;
  private phase: LoginPhase = "checking";

  constructor(root: ParentNode, options: PlatformClawLoginOptions = {}) {
    this.elements = readElements(root);
    const fetchImpl = options.fetchImpl;
    this.fetchImpl = fetchImpl
      ? (input, init) => fetchImpl(input, init)
      : (input, init) => globalThis.fetch(input, init);
    const location = options.location ?? window.location;
    this.returnTo = resolvePlatformClawReturnTo(location);
    this.navigate = options.navigate ?? ((path) => window.location.assign(path));
    this.sessionCheckTimeoutMs = options.sessionCheckTimeoutMs ?? SESSION_CHECK_TIMEOUT_MS;
  }

  start(): void {
    this.elements.form.addEventListener("submit", (event) => {
      void this.submit(event);
    });
    this.render();
    void this.checkSession();
  }

  private render(error?: string): void {
    const busy = this.phase !== "ready";
    this.elements.identifier.disabled = busy;
    this.elements.secretInput.disabled = busy;
    this.elements.submit.disabled = busy;
    this.elements.submit.textContent =
      this.phase === "checking"
        ? "세션 확인 중…"
        : this.phase === "submitting"
          ? "로그인 중…"
          : "로그인";
    this.elements.status.textContent =
      this.phase === "checking" ? "기존 로그인 상태를 확인하고 있습니다." : "";
    this.elements.error.hidden = !error;
    this.elements.error.textContent = error ?? "";
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
    this.render();
  }

  private async submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (this.phase !== "ready" || !this.elements.form.reportValidity()) {
      return;
    }
    this.phase = "submitting";
    this.render();
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
        this.elements.secretInput.focus();
        this.phase = "ready";
        this.render(loginFailureMessage(response.status, payload));
        return;
      }
      this.navigate(this.returnTo);
    } catch {
      this.phase = "ready";
      this.render("로그인 서버에 연결할 수 없습니다. 네트워크 상태를 확인해 주세요.");
    }
  }
}

const loginRoot = document.querySelector("[data-platformclaw-login]");
if (loginRoot) {
  new PlatformClawLoginController(loginRoot).start();
}
