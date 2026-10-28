import {
  parseSkillHubSecurityAudit,
  type SkillHubSecurityAudit,
  type SkillHubSkillDetail,
  type SkillHubVersion,
} from "./skill-hub-adapter.js";
import {
  readSkillHubArtifactMetadata,
  readSkillHubArtifactDeletion,
  type SkillHubIdentityReservation,
} from "./skill-hub-artifact-identity.js";
import {
  prepareSkillHubArtifactUpload,
  type SkillHubArtifactUpload,
} from "./skill-hub-publication-upload.js";

export type SkillHubArtifactIdentity = {
  skillId: number;
  versionId: number;
  namespace: string;
  slug: string;
};
export type SkillHubArtifactDeletion = {
  skillId: number;
  state: "pending" | "completed";
  completedAt?: string;
};

type ArtifactPublicationRequest = SkillHubArtifactUpload & {
  revalidateAuthority(): Promise<void>;
};

export interface SkillHubGovernanceClient {
  reserveArtifactIdentity(params: SkillHubIdentityReservation): Promise<SkillHubSkillDetail>;
  getArtifactSkill(params: {
    namespace: string;
    slug: string;
    expectedSkillId?: number;
    expectedPublicationId?: string;
  }): Promise<SkillHubSkillDetail>;
  listArtifactVersions(
    params: Omit<SkillHubArtifactIdentity, "versionId">,
  ): Promise<Array<Omit<SkillHubVersion, "downloadAvailable">>>;
  publishArtifact(params: ArtifactPublicationRequest): Promise<{
    skillId: number;
    namespace: string;
    slug: string;
    version: string;
  }>;
  listOwnedSkills?(
    page: number,
    size: number,
  ): Promise<{
    items: Array<{
      id: number;
      namespace: string;
      slug: string;
      displayName: string;
      summary: string;
      currentVersion: string | null;
    }>;
    total: number;
  }>;
  createNamespace?(params: {
    namespace: string;
    operationId: string;
  }): Promise<{ id: number; namespace: string }>;
  getArtifactSecurity(
    params: SkillHubArtifactIdentity,
  ): Promise<{ audits: SkillHubSecurityAudit[]; artifactAvailable: boolean; blocked: boolean }>;
  downloadArtifact(params: SkillHubArtifactIdentity): Promise<Buffer>;
  deleteArtifact(params: {
    skillId: number;
    namespace: string;
    slug: string;
  }): Promise<SkillHubArtifactDeletion>;
  getArtifactDeletion(skillId: number): Promise<SkillHubArtifactDeletion | null>;
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
const ARCHIVE_TRANSFER_TIMEOUT_MS = 10 * 60_000;

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

  async getArtifactSkill(params: {
    namespace: string;
    slug: string;
    expectedSkillId?: number;
    expectedPublicationId?: string;
  }) {
    if (
      params.expectedSkillId !== undefined &&
      (!Number.isSafeInteger(params.expectedSkillId) || params.expectedSkillId < 1)
    ) {
      throw new SkillHubGovernanceError("Invalid immutable artifact identity");
    }
    if (
      params.expectedPublicationId !== undefined &&
      !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(params.expectedPublicationId)
    ) {
      throw new SkillHubGovernanceError("Invalid managed publication identity");
    }
    await this.ensureLogin();
    const query = new URLSearchParams();
    if (params.expectedSkillId !== undefined) {
      query.set("expectedSkillId", String(params.expectedSkillId));
    }
    if (params.expectedPublicationId !== undefined) {
      query.set("expectedPublicationId", params.expectedPublicationId);
    }
    const result = await this.jsonRequest(
      `api/v1/admin/platformclaw/skills/coordinates/${encodeURIComponent(params.namespace)}/${encodeURIComponent(params.slug)}?${query}`,
      { method: "GET" },
      true,
    );
    return this.artifactMetadata(result.data, params);
  }

  async reserveArtifactIdentity(params: SkillHubIdentityReservation) {
    if (
      !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(params.publicationId) ||
      params.namespace !== `pc-${params.publicationId}` ||
      !params.slug
    ) {
      throw new SkillHubGovernanceError("Invalid managed publication identity");
    }
    await this.ensureLogin();
    // Persisted employee authority can change while the private session logs in.
    // The caller must still own this reservation immediately before its effect.
    await params.revalidateAuthority();
    const result = await this.jsonRequest(
      "api/v1/admin/platformclaw/skills/identities",
      {
        method: "POST",
        body: JSON.stringify({
          namespace: params.namespace,
          slug: params.slug,
          publicationId: params.publicationId,
        }),
      },
      true,
    );
    return this.artifactMetadata(result.data, params);
  }

  private artifactMetadata(
    value: unknown,
    params: { namespace: string; slug: string; expectedSkillId?: number },
  ) {
    const metadata = readSkillHubArtifactMetadata(value, params);
    if (!metadata) {
      throw new SkillHubGovernanceError("Invalid artifact metadata identity");
    }
    return metadata;
  }

  async listArtifactVersions(params: Omit<SkillHubArtifactIdentity, "versionId">) {
    if (!Number.isSafeInteger(params.skillId) || params.skillId < 1) {
      throw new SkillHubGovernanceError("Invalid immutable artifact identity");
    }
    await this.ensureLogin();
    const versions: Array<Omit<SkillHubVersion, "downloadAvailable">> = [];
    const seen = new Set<number>();
    let expectedTotal: number | undefined;
    const query = new URLSearchParams({
      namespace: params.namespace,
      slug: params.slug,
      size: "100",
    });
    for (let page = 0; ; page += 1) {
      query.set("page", String(page));
      const result = await this.jsonRequest(
        `api/v1/admin/platformclaw/skills/${params.skillId}/artifact/versions?${query}`,
        { method: "GET" },
        true,
      );
      const data = record(result.data, "artifact versions");
      if (
        !Array.isArray(data.items) ||
        !Number.isSafeInteger(data.total) ||
        Number(data.total) < 0 ||
        data.items.length > 100 ||
        (expectedTotal !== undefined && expectedTotal !== data.total) ||
        seen.size + data.items.length > Number(data.total)
      ) {
        throw new SkillHubGovernanceError("Artifact version history changed; refresh and retry");
      }
      expectedTotal = Number(data.total);
      for (const item of data.items) {
        const value = record(item, "artifact version");
        if (
          !Number.isSafeInteger(value.id) ||
          Number(value.id) < 1 ||
          seen.has(Number(value.id)) ||
          typeof value.version !== "string" ||
          !value.version ||
          typeof value.status !== "string" ||
          !value.status
        ) {
          throw new SkillHubGovernanceError("Invalid artifact version identity");
        }
        seen.add(Number(value.id));
        versions.push({
          id: Number(value.id),
          version: value.version,
          status: value.status,
          ...(typeof value.changelog === "string" ? { changelog: value.changelog } : {}),
          ...(typeof value.fileCount === "number" ? { fileCount: value.fileCount } : {}),
          ...(typeof value.totalSize === "number" ? { totalSize: value.totalSize } : {}),
          ...(typeof value.publishedAt === "string" ? { publishedAt: value.publishedAt } : {}),
        });
      }
      if (seen.size === expectedTotal) {
        return versions;
      }
      if (data.items.length === 0) {
        throw new SkillHubGovernanceError("Artifact version history is incomplete");
      }
    }
  }

  async publishArtifact(params: ArtifactPublicationRequest) {
    let upload: () => RequestInit;
    try {
      upload = prepareSkillHubArtifactUpload(params);
    } catch {
      throw new SkillHubGovernanceError("Invalid managed publication request");
    }
    await this.ensureLogin();
    // Login may await several network requests. Employee publication authority
    // belongs to the catalog owner and must still hold at the upload effect.
    await params.revalidateAuthority();
    const init = upload();
    const response = await this.request(
      "api/v1/admin/platformclaw/skills/publish",
      init,
      true,
      false,
      ARCHIVE_TRANSFER_TIMEOUT_MS,
    );
    const result = await this.decodeJson(response);
    if (result.code !== 0 && result.code !== 200) {
      throw new SkillHubGovernanceError("Skill Hub rejected the managed publication");
    }
    const data = record(result.data, "managed publication");
    if (
      !Number.isSafeInteger(data.skillId) ||
      Number(data.skillId) < 1 ||
      (params.expectedSkillId !== undefined && data.skillId !== params.expectedSkillId) ||
      data.namespace !== params.namespace ||
      typeof data.slug !== "string" ||
      !data.slug.trim() ||
      typeof data.version !== "string" ||
      !data.version.trim()
    ) {
      throw new SkillHubGovernanceError("Invalid managed publication identity");
    }
    return {
      skillId: Number(data.skillId),
      namespace: params.namespace,
      slug: data.slug,
      version: data.version,
    };
  }

  async listOwnedSkills(page: number, size: number) {
    await this.ensureLogin();
    const response = await this.jsonRequest(
      `api/v1/me/skills?filter=ALL&page=${page}&size=${size}`,
      { method: "GET" },
      true,
    );
    const data = record(response.data, "owned skills page");
    if (!Array.isArray(data.items) || !Number.isSafeInteger(data.total) || Number(data.total) < 0) {
      throw new SkillHubGovernanceError("Skill Hub returned invalid owned skills");
    }
    const items = data.items.map((item) => {
      const value = record(item, "owned skill");
      if (
        !Number.isSafeInteger(value.id) ||
        Number(value.id) < 1 ||
        typeof value.namespace !== "string" ||
        !value.namespace ||
        typeof value.slug !== "string" ||
        !value.slug
      ) {
        throw new SkillHubGovernanceError("Skill Hub returned invalid owned skill identity");
      }
      const headline = value.headlineVersion
        ? record(value.headlineVersion, "headline version")
        : null;
      return {
        id: Number(value.id),
        namespace: value.namespace,
        slug: value.slug,
        displayName: typeof value.displayName === "string" ? value.displayName : value.slug,
        summary: typeof value.summary === "string" ? value.summary : "",
        currentVersion: headline && typeof headline.version === "string" ? headline.version : null,
      };
    });
    return { items, total: Number(data.total) };
  }

  async createNamespace(params: {
    namespace: string;
    operationId: string;
  }): Promise<{ id: number; namespace: string }> {
    await this.ensureLogin();
    const description = `PlatformClaw namespace operation:${params.operationId}`;
    const namespacePath = `api/v1/namespaces/${encodeURIComponent(params.namespace)}`;
    const read = async () =>
      await this.namespaceRequest(namespacePath, { method: "GET" }, params.namespace);
    let response = await read();
    if (response === null) {
      try {
        response = await this.namespaceRequest(
          "api/v1/namespaces",
          {
            method: "POST",
            body: JSON.stringify({
              slug: params.namespace,
              displayName: params.namespace,
              description,
            }),
          },
          params.namespace,
        );
      } catch (error) {
        if (!(error instanceof SkillHubGovernanceError) || error.statusCode !== 409) {
          throw error;
        }
        // Another request may have committed the same persisted operation. Read
        // its marker once; a generic duplicate never authorizes namespace adoption.
        response = await read();
      }
    }
    const data = record(response?.data, "namespace");
    if (
      !Number.isSafeInteger(data.id) ||
      Number(data.id) < 1 ||
      data.slug !== params.namespace ||
      data.status !== "ACTIVE"
    ) {
      throw new SkillHubGovernanceError("Skill Hub returned invalid namespace metadata");
    }
    if (data.description !== description) {
      throw new SkillHubGovernanceError("Skill Hub namespace already exists", 409);
    }
    return { id: Number(data.id), namespace: params.namespace };
  }

  private async namespaceRequest(
    path: string,
    init: RequestInit,
    namespace: string,
  ): Promise<Record<string, unknown> | null> {
    const response = await this.request(
      path,
      { ...init, headers: { "Accept-Language": "en" } },
      true,
      true,
    );
    const body = await this.decodeJson(response);
    if (response.ok && (body.code === 0 || body.code === 200)) {
      return body;
    }
    // v0.2.16 has localized HTTP400 envelopes, not machine reason codes.
    // Pin English and match only the dependency's exact absence/duplicate contracts.
    if (
      init.method === "GET" &&
      response.status === 400 &&
      body.msg === `Namespace not found: ${namespace}`
    ) {
      return null;
    }
    if (
      init.method === "POST" &&
      response.status === 400 &&
      body.msg === `Namespace slug '${namespace}' already exists`
    ) {
      throw new SkillHubGovernanceError("Skill Hub namespace already exists", 409);
    }
    throw new SkillHubGovernanceError("Skill Hub rejected the namespace request", response.status);
  }

  private artifactPath(params: SkillHubArtifactIdentity, suffix: string) {
    if (
      !Number.isSafeInteger(params.skillId) ||
      params.skillId < 1 ||
      !Number.isSafeInteger(params.versionId) ||
      params.versionId < 1
    ) {
      throw new SkillHubGovernanceError("Invalid immutable artifact identity");
    }
    const query = new URLSearchParams({ namespace: params.namespace, slug: params.slug });
    return `api/v1/admin/platformclaw/skills/${params.skillId}/versions/${params.versionId}/${suffix}?${query}`;
  }

  async getArtifactSecurity(params: SkillHubArtifactIdentity) {
    await this.ensureLogin();
    const audits: SkillHubSecurityAudit[] = [];
    const seen = new Set<number>();
    let artifactAvailable = true;
    let blocked = false;
    let expectedTotal: number | undefined;
    for (let page = 0; ; page += 1) {
      const result = await this.jsonRequest(
        `${this.artifactPath(params, "security-audits")}&page=${page}&size=100`,
        { method: "GET" },
        true,
      );
      const data = record(result.data, "artifact security");
      if (
        !Array.isArray(data.items) ||
        !Number.isSafeInteger(data.total) ||
        Number(data.total) < 0 ||
        typeof data.artifactAvailable !== "boolean" ||
        typeof data.blocked !== "boolean"
      ) {
        throw new SkillHubGovernanceError("Invalid artifact security response");
      }
      const total = Number(data.total);
      if (
        data.items.length > 100 ||
        (expectedTotal !== undefined && expectedTotal !== total) ||
        seen.size + data.items.length > total
      ) {
        throw new SkillHubGovernanceError("Artifact audit history changed; refresh and retry");
      }
      expectedTotal = total;
      artifactAvailable &&= data.artifactAvailable;
      blocked ||= data.blocked;
      for (const item of data.items) {
        const raw = record(item, "artifact audit");
        if (!Number.isSafeInteger(raw.id) || Number(raw.id) < 1 || seen.has(Number(raw.id))) {
          throw new SkillHubGovernanceError(
            "Registry repeated an artifact audit; refresh and retry",
          );
        }
        seen.add(Number(raw.id));
        audits.push(parseSkillHubSecurityAudit(raw));
      }
      if (seen.size >= Number(data.total)) {
        break;
      }
      if (!data.items.length) {
        throw new SkillHubGovernanceError("Artifact audit history is incomplete");
      }
    }
    return { audits, artifactAvailable: artifactAvailable && !blocked, blocked };
  }

  async downloadArtifact(params: SkillHubArtifactIdentity) {
    await this.ensureLogin();
    const response = await this.request(
      this.artifactPath(params, "artifact"),
      { method: "GET", headers: { Accept: "application/zip" } },
      true,
      false,
      10 * 60_000,
    );
    return await this.readBytes(response, 500 * 1024 * 1024);
  }

  private deletion(value: unknown, skillId: number): SkillHubArtifactDeletion {
    const receipt = readSkillHubArtifactDeletion(value, skillId);
    if (!receipt) {
      throw new SkillHubGovernanceError("Invalid artifact deletion receipt");
    }
    return receipt;
  }

  async deleteArtifact(params: { skillId: number; namespace: string; slug: string }) {
    await this.ensureLogin();
    const query = new URLSearchParams({ namespace: params.namespace, slug: params.slug });
    const result = await this.jsonRequest(
      `api/v1/admin/platformclaw/skills/${params.skillId}/artifact?${query}`,
      { method: "DELETE" },
      true,
    );
    return this.deletion(result.data, params.skillId);
  }

  async getArtifactDeletion(skillId: number) {
    await this.ensureLogin();
    try {
      const result = await this.jsonRequest(
        `api/v1/admin/platformclaw/skills/${skillId}/artifact-deletion`,
        { method: "GET" },
        true,
      );
      return this.deletion(result.data, skillId);
    } catch (error) {
      if (error instanceof SkillHubGovernanceError && error.statusCode === 404) {
        return null;
      }
      throw error;
    }
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
    const body = await this.decodeJson(response);
    if (typeof body.code === "number" && body.code !== 0 && body.code !== 200) {
      throw new SkillHubGovernanceError("Skill Hub rejected the governance request");
    }
    return body;
  }

  private async readBytes(response: Response, limit: number): Promise<Buffer> {
    const declared = response.headers.get("content-length");
    if (declared && Number(declared) > limit) {
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
      if (size > limit) {
        void reader.cancel().catch(() => undefined);
        throw new SkillHubGovernanceError("Skill Hub governance response is oversized");
      }
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks, size);
  }

  private async decodeJson(response: Response) {
    const bytes = await this.readBytes(response, MAX_JSON_BYTES);
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
    allowBadRequest = false,
    timeoutMs = this.timeoutMs,
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    if (!headers.has("Accept")) {
      headers.set("Accept", "application/json");
    }
    if (typeof init.body === "string" && !headers.has("Content-Type")) {
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
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new SkillHubGovernanceError("Skill Hub governance service is unavailable");
    }
    this.captureCookies(response.headers);
    if (!response.ok && !(allowBadRequest && response.status === 400)) {
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
