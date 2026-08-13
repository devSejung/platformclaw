export type SkillHubVisibility = "PUBLIC" | "NAMESPACE_ONLY" | "PRIVATE";

export type SkillHubSearchItem = {
  namespace: string;
  slug: string;
  latestVersion: string;
  summary: string;
};

export type SkillHubVersion = {
  version: string;
  status: string;
  changelog?: string;
  fileCount?: number;
  totalSize?: number;
  publishedAt?: string;
  downloadAvailable: boolean;
};

export interface SkillHubAdapter {
  search(query: string, limit: number): Promise<{ items: SkillHubSearchItem[]; total: number }>;
  getSkill(namespace: string, slug: string): Promise<Record<string, unknown>>;
  listVersions(namespace: string, slug: string): Promise<SkillHubVersion[]>;
  publish(params: {
    namespace: string;
    archive: Buffer;
    filename: string;
    visibility: SkillHubVisibility;
  }): Promise<{ namespace: string; slug: string; version: string; visibility: SkillHubVisibility }>;
  download(namespace: string, slug: string, version: string): Promise<Buffer>;
}

export class SkillHubAdapterError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = "SkillHubAdapterError";
  }
}

type AdapterOptions = {
  baseUrl: string;
  token: string;
  maxArchiveBytes: number;
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
};

const MAX_JSON_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

function normalizeBaseUrl(raw: string): URL {
  const url = new URL(raw);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Skill Hub URL must be an HTTP(S) URL without credentials, query, or fragment");
  }
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/`;
  return url;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SkillHubAdapterError(`Skill Hub returned invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new SkillHubAdapterError(`Skill Hub returned invalid ${label}`);
  }
  return value.trim();
}

async function readBounded(response: Response, limit: number): Promise<Buffer> {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/u.test(declared) && Number(declared) > limit) {
    void response.body?.cancel().catch(() => undefined);
    throw new SkillHubAdapterError("Skill Hub response exceeds the configured size limit");
  }
  if (!response.body) {
    throw new SkillHubAdapterError("Skill Hub returned an empty response", response.status);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      return Buffer.concat(chunks, size);
    }
    size += value.byteLength;
    if (size > limit) {
      void reader.cancel().catch(() => undefined);
      throw new SkillHubAdapterError("Skill Hub response exceeds the configured size limit");
    }
    chunks.push(value);
  }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const bytes = await readBounded(response, MAX_JSON_BYTES);
  try {
    return record(JSON.parse(bytes.toString("utf8")), "JSON response");
  } catch (error) {
    if (error instanceof SkillHubAdapterError) {
      throw error;
    }
    throw new SkillHubAdapterError("Skill Hub returned invalid JSON", response.status);
  }
}

function apiData(body: Record<string, unknown>): unknown {
  if (typeof body.code === "number" && body.code !== 0 && body.code !== 200) {
    throw new SkillHubAdapterError(
      typeof body.msg === "string" ? body.msg : "Skill Hub rejected the request",
    );
  }
  return body.data;
}

function encodePath(value: string): string {
  return encodeURIComponent(value);
}

export class IflytekSkillHubAdapter implements SkillHubAdapter {
  private readonly baseUrl: URL;
  readonly #token: string;
  private readonly maxArchiveBytes: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(options: AdapterOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.#token = options.token.trim();
    if (!this.#token) {
      throw new Error("Skill Hub token is required");
    }
    if (!Number.isSafeInteger(options.maxArchiveBytes) || options.maxArchiveBytes <= 0) {
      throw new Error("Skill Hub archive limit must be a positive integer");
    }
    this.maxArchiveBytes = options.maxArchiveBytes;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async search(query: string, limit: number) {
    const url = this.url("api/cli/v1/skills/search");
    url.searchParams.set("q", query);
    url.searchParams.set("limit", String(limit));
    const data = record(apiData(await this.jsonRequest(url)), "search data");
    if (!Array.isArray(data.items) || typeof data.total !== "number") {
      throw new SkillHubAdapterError("Skill Hub returned invalid search results");
    }
    return {
      items: data.items.map((item) => {
        const value = record(item, "search item");
        return {
          namespace: stringValue(value.namespace, "search namespace"),
          slug: stringValue(value.slug, "search slug"),
          latestVersion: stringValue(value.latestVersion, "search version"),
          summary: typeof value.summary === "string" ? value.summary : "",
        };
      }),
      total: data.total,
    };
  }

  async getSkill(namespace: string, slug: string): Promise<Record<string, unknown>> {
    return record(
      apiData(
        await this.jsonRequest(
          this.url(`api/v1/skills/${encodePath(namespace)}/${encodePath(slug)}`),
        ),
      ),
      "skill detail",
    );
  }

  async listVersions(namespace: string, slug: string): Promise<SkillHubVersion[]> {
    const url = this.url(`api/v1/skills/${encodePath(namespace)}/${encodePath(slug)}/versions`);
    url.searchParams.set("page", "0");
    url.searchParams.set("size", "100");
    const data = record(apiData(await this.jsonRequest(url)), "version page");
    if (!Array.isArray(data.items)) {
      throw new SkillHubAdapterError("Skill Hub returned invalid versions");
    }
    return data.items.map((item) => {
      const value = record(item, "version");
      return {
        version: stringValue(value.version, "version number"),
        status: stringValue(value.status, "version status"),
        ...(typeof value.changelog === "string" ? { changelog: value.changelog } : {}),
        ...(typeof value.fileCount === "number" ? { fileCount: value.fileCount } : {}),
        ...(typeof value.totalSize === "number" ? { totalSize: value.totalSize } : {}),
        ...(typeof value.publishedAt === "string" ? { publishedAt: value.publishedAt } : {}),
        downloadAvailable: value.downloadAvailable === true,
      };
    });
  }

  async publish(params: {
    namespace: string;
    archive: Buffer;
    filename: string;
    visibility: SkillHubVisibility;
  }) {
    const form = new FormData();
    form.set("file", new Blob([params.archive]), params.filename);
    form.set("visibility", params.visibility);
    const data = record(
      apiData(
        await this.jsonRequest(
          this.url(`api/cli/v1/skills/${encodePath(params.namespace)}/publish`),
          { method: "POST", body: form },
        ),
      ),
      "publish result",
    );
    return {
      namespace: stringValue(data.namespace, "published namespace"),
      slug: stringValue(data.slug, "published slug"),
      version: stringValue(data.version, "published version"),
      visibility: stringValue(data.visibility, "published visibility") as SkillHubVisibility,
    };
  }

  async download(namespace: string, slug: string, version: string): Promise<Buffer> {
    const response = await this.request(
      this.url(
        `api/cli/v1/skills/${encodePath(namespace)}/${encodePath(slug)}/versions/${encodePath(version)}/download`,
      ),
    );
    return await readBounded(response, this.maxArchiveBytes);
  }

  private url(pathname: string): URL {
    return new URL(pathname, this.baseUrl);
  }

  private async jsonRequest(url: URL, init: RequestInit = {}): Promise<Record<string, unknown>> {
    return await readJson(await this.request(url, init));
  }

  private async request(url: URL, init: RequestInit = {}): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        headers: { Authorization: `Bearer ${this.#token}`, ...init.headers },
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new SkillHubAdapterError("Skill Hub is unavailable");
    }
    if (!response.ok) {
      const body = await readBounded(response, MAX_JSON_BYTES).catch(() => Buffer.alloc(0));
      let message = `Skill Hub request failed (${response.status})`;
      try {
        const parsed = record(JSON.parse(body.toString("utf8")), "error response");
        if (typeof parsed.msg === "string" && parsed.msg.trim()) {
          message = parsed.msg.trim();
        } else if (typeof parsed.message === "string" && parsed.message.trim()) {
          message = parsed.message.trim();
        }
      } catch {
        // Never echo an arbitrary upstream body; it may contain internal details.
      }
      if (message.includes(this.#token)) {
        message = message.replaceAll(this.#token, "[redacted]");
      }
      throw new SkillHubAdapterError(message, response.status);
    }
    return response;
  }
}
