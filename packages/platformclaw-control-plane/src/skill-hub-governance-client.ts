export interface SkillHubGovernanceClient {
  approvePendingReview(params: {
    namespace: string;
    slug: string;
    version: string;
    comment: string;
  }): Promise<{ reviewId: number; status: string }>;
}

export class SkillHubGovernanceError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = "SkillHubGovernanceError";
  }
}

type GovernanceClientOptions = {
  baseUrl: string;
  username: string;
  password: string;
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
};

const MAX_JSON_BYTES = 1024 * 1024;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SkillHubGovernanceError(`Skill Hub returned invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function normalizeBaseUrl(raw: string): URL {
  const url = new URL(raw);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Skill Hub governance URL must be a credential-free HTTP(S) URL");
  }
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/`;
  return url;
}

export class IflytekSkillHubGovernanceClient implements SkillHubGovernanceClient {
  private readonly baseUrl: URL;
  private readonly username: string;
  readonly #password: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly cookies = new Map<string, string>();
  private loginPromise?: Promise<void>;

  constructor(options: GovernanceClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.username = options.username.trim();
    this.#password = options.password;
    if (!this.username || !this.#password) {
      throw new Error("Skill Hub governance credentials are required");
    }
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async approvePendingReview(params: {
    namespace: string;
    slug: string;
    version: string;
    comment: string;
  }): Promise<{ reviewId: number; status: string }> {
    await this.ensureLogin();
    const page = await this.jsonRequest(
      "api/v1/reviews/my-submissions?page=0&size=100",
      { method: "GET" },
      true,
    );
    const data = record(page.data, "review page");
    if (!Array.isArray(data.items)) {
      throw new SkillHubGovernanceError("Skill Hub returned invalid review submissions");
    }
    const exact = data.items
      .map((item) => record(item, "review submission"))
      .filter(
        (item) =>
          item.namespace === params.namespace &&
          item.skillSlug === params.slug &&
          item.version === params.version,
      );
    const pending = exact.filter((item) => item.status === "PENDING");
    const approved = exact.filter((item) => item.status === "APPROVED");
    const matches = pending.length > 0 ? pending : approved;
    if (matches.length !== 1) {
      throw new SkillHubGovernanceError(
        matches.length === 0
          ? "Skill Hub has no pending review for this exact version"
          : "Skill Hub returned ambiguous pending reviews",
        409,
      );
    }
    const id = matches[0]!.id;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) {
      throw new SkillHubGovernanceError("Skill Hub returned an invalid review id");
    }
    if (matches[0]!.status === "APPROVED") {
      return { reviewId: id, status: "APPROVED" };
    }
    const approvalResponse = await this.jsonRequest(
      `api/v1/reviews/${encodeURIComponent(String(id))}/approve`,
      { method: "POST", body: JSON.stringify({ comment: params.comment }) },
      true,
    );
    const result = record(approvalResponse.data, "review approval");
    if (result.id !== id || typeof result.status !== "string") {
      throw new SkillHubGovernanceError("Skill Hub returned a mismatched review approval");
    }
    return { reviewId: id, status: result.status };
  }

  private async ensureLogin(): Promise<void> {
    if (this.cookies.has("SESSION") || this.cookies.has("JSESSIONID")) {
      return;
    }
    this.loginPromise ??= this.login().finally(() => {
      this.loginPromise = undefined;
    });
    await this.loginPromise;
  }

  private async login(): Promise<void> {
    // v0.2.16 issues the anonymous CSRF cookie from auth/methods before direct login.
    await this.request("api/v1/auth/methods", { method: "GET" }, false);
    await this.jsonRequest(
      "api/v1/auth/direct/login",
      {
        method: "POST",
        body: JSON.stringify({
          provider: "local",
          username: this.username,
          password: this.#password,
        }),
      },
      false,
    );
    if (!this.cookies.has("SESSION") && !this.cookies.has("JSESSIONID")) {
      throw new SkillHubGovernanceError("Skill Hub did not establish a governance session");
    }
  }

  private async jsonRequest(path: string, init: RequestInit, authenticated: boolean) {
    const response = await this.request(path, init, authenticated);
    const declared = response.headers.get("content-length");
    if (declared && Number(declared) > MAX_JSON_BYTES) {
      throw new SkillHubGovernanceError("Skill Hub governance response is oversized");
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > MAX_JSON_BYTES) {
      throw new SkillHubGovernanceError("Skill Hub governance response is oversized");
    }
    try {
      return record(JSON.parse(bytes.toString("utf8")), "governance JSON");
    } catch (error) {
      if (error instanceof SkillHubGovernanceError) {
        throw error;
      }
      throw new SkillHubGovernanceError("Skill Hub returned invalid governance JSON");
    }
  }

  private async request(
    path: string,
    init: RequestInit,
    authenticated: boolean,
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (init.body) {
      headers.set("Content-Type", "application/json");
    }
    const cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    if (cookie) {
      headers.set("Cookie", cookie);
    }
    if (init.method && !["GET", "HEAD"].includes(init.method.toUpperCase())) {
      const csrf = this.cookies.get("XSRF-TOKEN");
      if (csrf) {
        headers.set("X-XSRF-TOKEN", decodeURIComponent(csrf));
      }
    }
    let response: Response;
    try {
      response = await this.fetchImpl(new URL(path, this.baseUrl), {
        ...init,
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new SkillHubGovernanceError("Skill Hub governance service is unavailable");
    }
    this.captureCookies(response.headers);
    if (!response.ok) {
      if (authenticated && (response.status === 401 || response.status === 403)) {
        this.cookies.clear();
      }
      throw new SkillHubGovernanceError(
        `Skill Hub governance request failed (${response.status})`,
        response.status,
      );
    }
    return response;
  }

  private captureCookies(headers: Headers): void {
    const values =
      typeof headers.getSetCookie === "function"
        ? headers.getSetCookie()
        : (headers.get("set-cookie")?.split(/,(?=[^;,]+=)/u) ?? []);
    for (const value of values) {
      const pair = value.split(";", 1)[0];
      const separator = pair?.indexOf("=") ?? -1;
      if (pair && separator > 0) {
        this.cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
      }
    }
  }
}
