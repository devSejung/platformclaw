import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import loginHtml from "../../platformclaw-login.html?raw";
import { LOCALE_STORAGE_KEY } from "../i18n/lib/locale-preferences.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { applyPlatformClawLoginCopy } from "./login-copy.ts";
import { PlatformClawLoginController } from "./login.ts";
import { PLATFORMCLAW_LOGIN_API_PATH, PLATFORMCLAW_SESSION_API_PATH } from "./web-contract.ts";

const fixtureValue = "fixture";
const controllers: PlatformClawLoginController[] = [];
let previousDocumentLocale: { title: string; lang: string; dir: string };

function fixture(): HTMLElement {
  const page = new DOMParser().parseFromString(loginHtml, "text/html");
  const root = page.querySelector<HTMLElement>("[data-platformclaw-login]");
  if (!root) {
    throw new Error("Login page missing");
  }
  document.body.append(root);
  applyPlatformClawLoginCopy(root);
  return root;
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

async function start(fetchImpl?: typeof fetch, timeout?: number) {
  const root = fixture();
  const navigate = vi.fn();
  const controller = new PlatformClawLoginController(root, {
    fetchImpl,
    navigate,
    location: window.location,
    sessionCheckTimeoutMs: timeout,
  });
  controllers.push(controller);
  controller.start();
  await vi.waitFor(() =>
    expect(root.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false),
  );
  return { root, navigate, controller };
}

function submit(root: ParentNode): void {
  const identifier = root.querySelector<HTMLInputElement>('input[name="identifier"]');
  const secondInput = root.querySelector<HTMLInputElement>('input[name="password"]');
  const form = root.querySelector<HTMLFormElement>("form");
  if (!identifier || !secondInput || !form) {
    throw new Error("login fixture missing");
  }
  identifier.value = "person.one";
  secondInput.value = fixtureValue;
  form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
}

describe("PlatformClawLoginController", () => {
  beforeEach(() => {
    previousDocumentLocale = {
      title: document.title,
      lang: document.documentElement.lang,
      dir: document.documentElement.dir,
    };
    window.history.replaceState({}, "", "/platformclaw/login");
    vi.stubGlobal("localStorage", createStorageMock());
    localStorage.setItem(LOCALE_STORAGE_KEY, "ko");
  });
  afterEach(() => {
    for (const controller of controllers.splice(0)) {
      controller.dispose();
    }
    document.body.replaceChildren();
    document.title = previousDocumentLocale.title;
    document.documentElement.lang = previousDocumentLocale.lang;
    document.documentElement.dir = previousDocumentLocale.dir;
    vi.unstubAllGlobals();
  });

  it.each([
    ["ko", "사내 LLM", "사외 Claude", "반드시 확인해 주세요"],
    ["en", "internal LLM", "external Claude", "company’s security policy"],
  ])(
    "keeps one %s security notice after the form during bootstrap",
    (locale, primary, external, policy) => {
      localStorage.setItem(LOCALE_STORAGE_KEY, locale);
      const root = fixture();
      const notice = root.querySelector(".login-security-notice");
      const form = root.querySelector("form");
      expect(notice?.querySelectorAll("p")).toHaveLength(1);
      expect(notice?.textContent).toContain(primary);
      expect(notice?.textContent).toContain(external);
      expect(notice?.textContent).toContain(policy);
      expect(notice?.querySelectorAll("p > br")).toHaveLength(1);
      expect(notice?.querySelector("button, input, a")).toBeNull();
      expect(notice?.hasAttribute("hidden")).toBe(false);
      expect(
        notice && form && form.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(root.querySelector<HTMLInputElement>('input[name="identifier"]')?.disabled).toBe(true);
    },
  );

  it("checks the opaque session before enabling sign-in", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response({ authenticated: false }));
    const { root } = await start(fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith(
      PLATFORMCLAW_SESSION_API_PATH,
      expect.objectContaining({ credentials: "include", signal: expect.any(AbortSignal) }),
    );
    expect(root.querySelector<HTMLInputElement>('input[name="identifier"]')?.disabled).toBe(false);
    expect(root.querySelector<HTMLAnchorElement>("[data-login-adsso]")?.getAttribute("href")).toBe(
      "/employee/auth/adsso?returnTo=%2Fplatformclaw%2Fapp%2Fchat",
    );
  });

  it("enables sign-in when session bootstrap stalls", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
        await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted")), {
            once: true,
          });
        }),
    );
    const { root } = await start(fetchImpl, 5);
    expect(root.querySelector('button[type="submit"]')?.textContent).toBe(
      localStorage.getItem(LOCALE_STORAGE_KEY) === "en" ? "Sign in" : "로그인",
    );
  });

  it("shows a clear error when ADSSO is unavailable", async () => {
    window.history.replaceState({}, "", "/platformclaw/login?adssoError=unavailable");
    const { root } = await start(async () => response({ authenticated: false }));
    expect(root.querySelector('[role="alert"]')?.textContent).toContain(
      "ADSSO 로그인 서비스를 사용할 수 없습니다",
    );
  });

  it("clears the secret field after rejected credentials", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ authenticated: false }))
      .mockResolvedValueOnce(response({ authenticated: false }, 401));
    const { root, navigate } = await start(fetchImpl);
    submit(root);
    await vi.waitFor(() =>
      expect(root.querySelector('[role="alert"]')?.textContent).toContain("아이디"),
    );
    expect(fetchImpl).toHaveBeenLastCalledWith(
      PLATFORMCLAW_LOGIN_API_PATH,
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
    expect(root.querySelector<HTMLInputElement>('input[name="password"]')?.value).toBe("");
    expect(navigate).not.toHaveBeenCalled();
    expect(root.querySelector(".login-security-notice")?.hasAttribute("hidden")).toBe(false);
  });

  it("enters the sanitized application return route", async () => {
    window.history.replaceState(
      {},
      "",
      "/platformclaw/login?returnTo=%2Fplatformclaw%2Fapp%2Fsessions",
    );
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ authenticated: false }))
      .mockResolvedValueOnce(response({ authenticated: true }));
    const { root, navigate } = await start(fetchImpl);
    expect(root.querySelector<HTMLAnchorElement>("[data-login-adsso]")?.getAttribute("href")).toBe(
      "/employee/auth/adsso?returnTo=%2Fplatformclaw%2Fapp%2Fsessions",
    );
    submit(root);
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith("/platformclaw/app/sessions"));
  });

  it("calls the browser fetch function with the browser global receiver", async () => {
    let callCount = 0;
    const fetchImpl = function (this: unknown): Promise<Response> {
      if (this !== globalThis) {
        throw new TypeError("invalid fetch receiver");
      }
      callCount += 1;
      return Promise.resolve(response({ authenticated: callCount === 2 }));
    } as typeof fetch;
    vi.stubGlobal("fetch", fetchImpl);
    const { root, navigate } = await start();

    submit(root);

    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith("/platformclaw/app/chat"));
  });
  it.each([
    [401, "Check your account ID and password."],
    [429, "Too many sign-in attempts. Try again in a moment."],
    [403, "This account cannot sign in. Contact your administrator."],
    [409, "The sign-in session limit has been reached. Contact your administrator."],
    [503, "Could not sign in. Try again in a moment."],
  ])("localizes authentication failure %s in saved English", async (status, expected) => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ authenticated: false }))
      .mockResolvedValueOnce(response({ authenticated: false }, status));
    const { root } = await start(fetchImpl);
    submit(root);
    await vi.waitFor(() =>
      expect(root.querySelector("[data-login-error]")?.textContent).toBe(expected),
    );
    expect(root.querySelector('button[type="submit"]')?.textContent).toBe("Sign in");
    expect(root.querySelector<HTMLInputElement>('input[name="password"]')?.value).toBe("");
  });

  it("uses saved English for ADSSO and network failures", async () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    window.history.replaceState({}, "", "/platformclaw/login?adssoError=unavailable");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ authenticated: false }))
      .mockRejectedValueOnce(new Error("offline"));
    const { root } = await start(fetchImpl);
    expect(root.querySelector("[data-login-error]")?.textContent).toBe(
      "ADSSO sign-in is unavailable. Contact your administrator.",
    );
    submit(root);
    await vi.waitFor(() =>
      expect(root.querySelector("[data-login-error]")?.textContent).toBe(
        "Could not reach the sign-in server. Check your network connection.",
      ),
    );
  });

  it("updates an existing error and shadow copy without remounting visuals or changing credentials", async () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ authenticated: false }))
      .mockResolvedValueOnce(response({ authenticated: false }, 401));
    const { root, controller } = await start(fetchImpl);
    submit(root);
    await vi.waitFor(() =>
      expect(root.querySelector("[data-login-error]")?.textContent).toContain("Check your account"),
    );
    const password = root.querySelector<HTMLInputElement>('input[name="password"]')!;
    password.value = "still-editing";
    password.focus();
    const hero = root.querySelector<HTMLElement>("[data-login-hero]")!;
    const scene = hero.shadowRoot?.querySelector(".hero");
    const mascot = root.querySelector("[data-login-mascot]")?.firstChild;
    localStorage.setItem(LOCALE_STORAGE_KEY, "ko");
    window.dispatchEvent(new StorageEvent("storage", { key: LOCALE_STORAGE_KEY }));
    expect(root.querySelector("[data-login-error]")?.textContent).toBe(
      "아이디 또는 비밀번호를 확인해 주세요.",
    );
    expect(hero.shadowRoot?.querySelector('[data-login-copy="heroTools"]')?.textContent).toBe(
      "도구",
    );
    expect(hero.shadowRoot?.querySelector(".hero")).toBe(scene);
    expect(root.querySelector("[data-login-mascot]")?.firstChild).toBe(mascot);
    expect(document.activeElement).toBe(password);
    expect(password.value).toBe("still-editing");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    controller.dispose();
    localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    window.dispatchEvent(new StorageEvent("storage", { key: LOCALE_STORAGE_KEY }));
    expect(root.querySelector('button[type="submit"]')?.textContent).toBe("로그인");
    expect(root.querySelector("[data-login-mascot]")?.childNodes).toHaveLength(0);
  });

  it("keeps an in-flight submission disabled while the language changes", async () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    let finish!: (result: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ authenticated: false }))
      .mockReturnValueOnce(pending);
    const { root, navigate } = await start(fetchImpl);
    submit(root);
    expect(root.querySelector('button[type="submit"]')?.textContent).toBe("Signing in…");
    localStorage.setItem(LOCALE_STORAGE_KEY, "ko");
    window.dispatchEvent(new StorageEvent("storage", { key: LOCALE_STORAGE_KEY }));
    expect(root.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    expect(root.querySelector('button[type="submit"]')?.textContent).toBe("로그인 중…");
    finish(response({ authenticated: true }));
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith("/platformclaw/app/chat"));
  });

  it("keeps unknown server diagnostic text as text", async () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    const diagnostic = "Maintenance window <details>";
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ authenticated: false }))
      .mockResolvedValueOnce(response({ authenticated: false, message: diagnostic }, 503));
    const { root } = await start(fetchImpl);
    submit(root);
    await vi.waitFor(() =>
      expect(root.querySelector("[data-login-error]")?.textContent).toBe(diagnostic),
    );
    expect(root.querySelector("[data-login-error] details")).toBeNull();
  });

  it("preserves cached visuals and cleans them only when the page is discarded", async () => {
    const { root } = await start(async () => response({ authenticated: false }));
    const password = root.querySelector<HTMLInputElement>('input[name="password"]')!;
    password.value = "still-editing";
    const mascot = root.querySelector("[data-login-mascot]")?.firstChild;
    const hero = root
      .querySelector<HTMLElement>("[data-login-hero]")
      ?.shadowRoot?.querySelector(".hero");
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    expect(root.querySelector("[data-login-mascot]")?.firstChild).toBe(mascot);
    expect(
      root.querySelector<HTMLElement>("[data-login-hero]")?.shadowRoot?.querySelector(".hero"),
    ).toBe(hero);
    expect(password.value).toBe("still-editing");
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }));
    expect(root.querySelector("[data-login-mascot]")?.childNodes).toHaveLength(0);
  });

  it("follows browser language changes in system mode without persisting them", async () => {
    localStorage.removeItem(LOCALE_STORAGE_KEY);
    vi.stubGlobal("navigator", { language: "en-US" });
    const { root } = await start(async () => response({ authenticated: false }));
    expect(root.querySelector('button[type="submit"]')?.textContent).toBe("Sign in");
    vi.stubGlobal("navigator", { language: "ko-KR" });
    window.dispatchEvent(new Event("languagechange"));
    expect(root.querySelector('button[type="submit"]')?.textContent).toBe("로그인");
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBeNull();
  });
});
