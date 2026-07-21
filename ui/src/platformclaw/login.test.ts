import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformClawLoginController } from "./login.ts";
import { PLATFORMCLAW_LOGIN_API_PATH, PLATFORMCLAW_SESSION_API_PATH } from "./web-contract.ts";

const fixtureValue = "fixture";

function fixture(): HTMLElement {
  const root = document.createElement("main");
  root.innerHTML = `
    <form data-login-form novalidate>
      <label>아이디<input name="identifier" required disabled></label>
      <label>비밀번호<input name="password" type="password" required disabled></label>
      <p data-login-error role="alert" hidden></p>
      <button type="submit" disabled>세션 확인 중…</button>
    </form>
    <p data-login-status></p>`;
  document.body.append(root);
  return root;
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

async function start(fetchImpl: typeof fetch, timeout?: number) {
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
  afterEach(() => document.body.replaceChildren());

  it("checks the opaque session before enabling sign-in", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response({ authenticated: false }));
    const { root } = await start(fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith(
      PLATFORMCLAW_SESSION_API_PATH,
      expect.objectContaining({ credentials: "include", signal: expect.any(AbortSignal) }),
    );
    expect(root.querySelector<HTMLInputElement>('input[name="identifier"]')?.disabled).toBe(false);
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
    submit(root);
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith("/platformclaw/app/sessions"));
  });
});
