import type { IncomingMessage, ServerResponse } from "node:http";
import { readPlatformClawSessionCookie, type JsonBodyReader } from "./browser-auth-http.js";
import type { BrowserAuthService } from "./browser-auth-service.js";
import type { PlatformUser } from "./contracts.js";

export const PLATFORMCLAW_VOC_API_PATH = "/platformclaw/api/voc";

const BODY_LIMIT_BYTES = 64 * 1024;
const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 8_000;
const JIRA_REQUEST_TIMEOUT_MS = 15_000;

export type JiraVocConfig = {
  baseUrl: string;
  projectKey: string;
  parentIssueKey?: string;
  issueType: string;
  assignee?: string;
  components: readonly string[];
  coworkerField?: string;
  defaultCoworkers: readonly string[];
  authorization: string;
};

export type VocIssue = { issueKey: string; issueUrl: string };

type Fetch = typeof globalThis.fetch;

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new VocRequestError("request body must be an object");
  }
  return value as Record<string, unknown>;
}

function requiredText(body: Record<string, unknown>, field: string, maxLength: number): string {
  const value = body[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new VocRequestError(`${field} is required`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new VocRequestError(`${field} must be at most ${maxLength} characters`);
  }
  return normalized;
}

class VocRequestError extends Error {}

function reporterDescription(description: string, user: PlatformUser): string {
  const reporter = user.displayName?.trim() || user.accountId;
  return `${description}\n\n---\nReporter: ${reporter} (${user.employeeId})`;
}

function jiraFields(config: JiraVocConfig, user: PlatformUser, title: string, description: string) {
  const coworkers = [
    ...new Set(
      [...config.defaultCoworkers, config.assignee, user.employeeId].filter(
        (value): value is string => Boolean(value),
      ),
    ),
  ];
  return {
    project: { key: config.projectKey },
    ...(config.parentIssueKey ? { parent: { key: config.parentIssueKey } } : {}),
    summary: `[VOC] ${title}`,
    description: reporterDescription(description, user),
    issuetype: { name: config.issueType },
    ...(config.components.length > 0
      ? { components: config.components.map((name) => ({ name })) }
      : {}),
    ...(config.assignee ? { assignee: { name: config.assignee } } : {}),
    ...(config.coworkerField && coworkers.length > 0
      ? { [config.coworkerField]: coworkers.map((name) => ({ name })) }
      : {}),
  };
}

export class JiraVocService {
  private readonly fetchImpl: Fetch;

  constructor(
    private readonly options: {
      authService: BrowserAuthService;
      config: JiraVocConfig;
      fetchImpl?: Fetch;
    },
  ) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async authenticate(token: string) {
    const result = await this.options.authService.authenticateToken(token);
    return result.status === "active" ? result : null;
  }

  async create(user: PlatformUser, title: string, description: string): Promise<VocIssue> {
    const endpoint = new URL("rest/api/2/issue", `${this.options.config.baseUrl}/`);
    let response: Response;
    try {
      response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: this.options.config.authorization,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          fields: jiraFields(this.options.config, user, title, description),
        }),
        signal: AbortSignal.timeout(JIRA_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error("Jira is unavailable", { cause: error });
    }
    if (!response.ok) {
      throw new Error(`Jira issue creation failed (${response.status})`);
    }
    const body = (await response.json()) as { key?: unknown };
    if (typeof body.key !== "string" || !body.key.trim()) {
      throw new Error("Jira returned an invalid issue response");
    }
    const issueKey = body.key.trim();
    return {
      issueKey,
      issueUrl: new URL(
        `browse/${encodeURIComponent(issueKey)}`,
        `${this.options.config.baseUrl}/`,
      ).toString(),
    };
  }
}

export async function handlePlatformClawVocRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    service: JiraVocService;
    readJsonBody: JsonBodyReader;
    isMutationOriginAllowed(req: IncomingMessage): boolean;
  },
): Promise<boolean> {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  if (pathname !== PLATFORMCLAW_VOC_API_PATH) {
    return false;
  }
  if ((req.method ?? "GET").toUpperCase() !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.end("Method Not Allowed");
    return true;
  }
  const token = readPlatformClawSessionCookie(req);
  const auth = token ? await options.service.authenticate(token) : null;
  if (!auth) {
    sendJson(res, 401, { error: "authentication required" });
    return true;
  }
  if (!options.isMutationOriginAllowed(req)) {
    sendJson(res, 403, { error: "origin not allowed" });
    return true;
  }
  try {
    const read = await options.readJsonBody(req, BODY_LIMIT_BYTES);
    if (!read.ok) {
      sendJson(res, 400, { error: read.error });
      return true;
    }
    const body = objectBody(read.value);
    const issue = await options.service.create(
      auth.user,
      requiredText(body, "title", MAX_TITLE_LENGTH),
      requiredText(body, "description", MAX_DESCRIPTION_LENGTH),
    );
    sendJson(res, 201, { ok: true, ...issue });
  } catch (error) {
    sendJson(res, error instanceof VocRequestError ? 400 : 503, {
      error: error instanceof Error ? error.message : "VOC registration failed",
    });
  }
  return true;
}
