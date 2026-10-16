import type { SkillHubVisibility } from "./skill-hub-adapter.js";

export type SkillHubEditableMetadata = {
  id: number;
  namespace: string;
  slug: string;
  revision: string;
  displayName: string;
  summary: string;
  visibility: SkillHubVisibility;
  effectiveVisibility: SkillHubVisibility;
  reviewVersions: string[];
};

export type SkillHubRegistryEdit = {
  operationId: string;
  skillId: number;
  namespace: string;
  slug: string;
  expectedRevision: string;
  targetNamespace: string;
  displayName: string;
  summary: string;
  visibility: SkillHubVisibility;
};

export interface SkillHubGovernanceClient {
  getEditableSkill?(namespace: string, slug: string): Promise<SkillHubEditableMetadata>;
  editSkill?(params: SkillHubRegistryEdit): Promise<SkillHubEditableMetadata>;
  approvePendingReview(params: {
    namespace: string;
    slug: string;
    version: string;
    comment: string;
    requireSafeScan?: boolean;
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

function editableMetadata(value: unknown): SkillHubEditableMetadata {
  const data = record(value, "editable skill");
  if (
    !Number.isSafeInteger(data.id) ||
    Number(data.id) < 1 ||
    typeof data.namespace !== "string" ||
    !data.namespace ||
    typeof data.slug !== "string" ||
    !data.slug ||
    typeof data.revision !== "string" ||
    !data.revision ||
    typeof data.displayName !== "string" ||
    !data.displayName.trim() ||
    typeof data.summary !== "string" ||
    !["PUBLIC", "NAMESPACE_ONLY", "PRIVATE"].includes(String(data.visibility)) ||
    !["PUBLIC", "NAMESPACE_ONLY", "PRIVATE"].includes(String(data.effectiveVisibility)) ||
    !Array.isArray(data.reviewVersions) ||
    data.reviewVersions.some(
      (version) => typeof version !== "string" || !version || version.length > 100,
    )
  ) {
    throw new SkillHubGovernanceError("Skill Hub returned invalid editable skill metadata");
  }
  return data as SkillHubEditableMetadata;
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

  async getEditableSkill(namespace: string, slug: string): Promise<SkillHubEditableMetadata> {
    await this.ensureLogin();
    const response = await this.jsonRequest(
      `api/v1/admin/platformclaw/skills/${encodeURIComponent(namespace)}/${encodeURIComponent(slug)}`,
      { method: "GET" },
      true,
    );
    const metadata = editableMetadata(response.data);
    if (metadata.namespace !== namespace || metadata.slug !== slug) {
      throw new SkillHubGovernanceError("Skill Hub returned mismatched editable skill metadata");
    }
    return metadata;
  }

  async editSkill(params: SkillHubRegistryEdit): Promise<SkillHubEditableMetadata> {
    await this.ensureLogin();
    const response = await this.jsonRequest(
      `api/v1/admin/platformclaw/skills/${encodeURIComponent(String(params.skillId))}`,
      { method: "PATCH", body: JSON.stringify(params) },
      true,
    );
    const metadata = editableMetadata(response.data);
    if (
      metadata.id !== params.skillId ||
      metadata.namespace !== params.targetNamespace ||
      metadata.slug !== params.slug ||
      metadata.displayName !== params.displayName ||
      metadata.summary !== params.summary ||
      metadata.visibility !== params.visibility
    ) {
      throw new SkillHubGovernanceError("Skill Hub returned a mismatched edit result");
    }
    return metadata;
  }

  async approvePendingReview(params: {
    namespace: string;
    slug: string;
    version: string;
    comment: string;
    requireSafeScan?: boolean;
  }): Promise<{ reviewId: number; status: string }> {
    await this.ensureLogin();
    const response = await this.jsonRequest(
      `api/v1/admin/platformclaw/skills/${encodeURIComponent(params.namespace)}/${encodeURIComponent(params.slug)}/versions/${encodeURIComponent(params.version)}/review`,
      { method: "GET" },
      true,
    );
    const review = record(response.data, "exact version review");
    if (
      review.namespace !== params.namespace ||
      review.skillSlug !== params.slug ||
      review.version !== params.version ||
      !["PENDING", "APPROVED"].includes(String(review.status))
    ) {
      throw new SkillHubGovernanceError("Skill Hub returned a mismatched exact version review");
    }
    const id = review.id;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) {
      throw new SkillHubGovernanceError("Skill Hub returned an invalid review id");
    }
    if (review.status === "APPROVED" && !params.requireSafeScan) {
      return { reviewId: id, status: "APPROVED" };
    }
    const approvalResponse = await this.jsonRequest(
      params.requireSafeScan
        ? `api/v1/admin/platformclaw/skills/${encodeURIComponent(params.namespace)}/${encodeURIComponent(params.slug)}/versions/${encodeURIComponent(params.version)}/approve-safe`
        : `api/v1/reviews/${encodeURIComponent(String(id))}/approve`,
      { method: "POST", body: JSON.stringify({ comment: params.comment }) },
      true,
    );
    const result = record(approvalResponse.data, "review approval");
    if (result.id !== id || result.status !== "APPROVED") {
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
      void response.body?.cancel().catch(() => undefined);
      throw new SkillHubGovernanceError("Skill Hub governance response is oversized");
    }
    const reader = response.body?.getReader();
    if (!reader) {
      throw new SkillHubGovernanceError("Skill Hub governance response is empty");
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      size += chunk.value.byteLength;
      if (size > MAX_JSON_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new SkillHubGovernanceError("Skill Hub governance response is oversized");
      }
      chunks.push(chunk.value);
    }
    const bytes = Buffer.concat(chunks, size);
    try {
      const body = record(JSON.parse(bytes.toString("utf8")), "governance JSON");
      if (typeof body.code === "number" && body.code !== 0 && body.code !== 200) {
        throw new SkillHubGovernanceError("Skill Hub rejected the governance request");
      }
      return body;
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
