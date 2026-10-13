import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import loginHtml from "../../platformclaw-login.html?raw";
import { PlatformClawLoginController } from "./login.ts";
import { PLATFORMCLAW_LOGIN_API_PATH, PLATFORMCLAW_SESSION_API_PATH } from "./web-contract.ts";

const fixtureValue = "fixture";

function fixture(): HTMLElement {
  const page = new DOMParser().parseFromString(loginHtml, "text/html");
  const root = page.querySelector<HTMLElement>("[data-platformclaw-login]");
  if (!root) {
    throw new Error("Login page missing");
  }
  document.body.append(root);
  return root;
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

async function start(fetchImpl?: typeof fetch, timeout?: number) {
  const root = fixture();
  const navigate = vi.fn();
  new PlatformClawLoginController(root, {
    fetchImpl,
    navigate,
    location: window.location,
    sessionCheckTimeoutMs: timeout,
  }).start();
  await vi.waitFor(() => expect(root.querySelector("button")?.textContent).toBe("로그인"));
  return { root, navigate };
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
  beforeEach(() => window.history.replaceState({}, "", "/platformclaw/login"));
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("keeps both security notices before sign-in while session bootstrap is pending", () => {
    const root = fixture();
    const notice = root.querySelector(".login-security-notice");
    const form = root.querySelector("form");
    expect(notice?.querySelector('[lang="ko"]')?.textContent).toContain("사내 LLM");
    expect(notice?.querySelector('p[lang="en"]')?.textContent).toMatch(
      /external Claude\s+via ACP/u,
    );
    expect(notice?.querySelector('p[lang="en"]')?.textContent).toContain(
      "Regular conversations are processed by our internal LLM",
    );
    expect(notice?.querySelector('p[lang="ko"]')?.textContent).toContain("반드시 확인해 주세요");
    expect(notice?.querySelector('p[lang="en"]')?.textContent).toMatch(/Be sure to check/u);
    expect(notice?.querySelectorAll("p > br")).toHaveLength(2);
    expect(notice?.querySelector("button, input, a")).toBeNull();
    expect(notice?.hasAttribute("hidden")).toBe(false);
    expect(
      notice && form && notice.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(root.querySelector<HTMLInputElement>('input[name="identifier"]')?.disabled).toBe(true);
  });

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
    expect(root.querySelector("button")?.textContent).toBe("로그인");
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
});
