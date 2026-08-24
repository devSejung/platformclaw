import type { IncomingMessage, ServerResponse } from "node:http";
import { readPlatformClawSessionCookie, type JsonBodyReader } from "./browser-auth-http.js";
import type { BrowserAuthService } from "./browser-auth-service.js";
import { sendBrowserJson } from "./browser-http-shared.js";
import {
  ControlPlaneAuthorizationError,
  ControlPlaneConflictError,
  ControlPlaneNotFoundError,
  ControlPlaneStateError,
  type ManagedScope,
  type ManagedScopeKind,
  type ManagedScopeRole,
} from "./contracts.js";
import { OrganizationService } from "./organization-service.js";

export const PLATFORMCLAW_ORGANIZATION_PATH = "/platformclaw/api/organization";
const BODY_LIMIT_BYTES = 16 * 1024;
const MAX_ID_CHARS = 160;
const MAX_QUERY_CHARS = 128;
const MAX_REASON_CHARS = 500;
const MAX_NAME_CHARS = 120;
const MAX_LIST_LIMIT = 200;

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ControlPlaneStateError("invalid request body");
  }
  return value as Record<string, unknown>;
}

function exactKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(body).find((key) => !allowedKeys.has(key));
  if (unknown) {
    throw new ControlPlaneStateError(`unknown request field: ${unknown}`);
  }
}

function requiredString(body: Record<string, unknown>, name: string, maxChars: number): string {
  const value = body[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new ControlPlaneStateError(`${name} is required`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxChars) {
    throw new ControlPlaneStateError(`${name} must not exceed ${maxChars} characters`);
  }
  return trimmed;
}

function optionalNullableId(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name];
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !value.trim() || value.trim().length > MAX_ID_CHARS) {
    throw new ControlPlaneStateError(`${name} must be a valid identifier or null`);
  }
  return value.trim();
}

function enumField<T extends string>(
  body: Record<string, unknown>,
  name: string,
  allowed: readonly T[],
): T {
  const value = body[name];
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ControlPlaneStateError(`${name} is invalid`);
  }
  return value as T;
}

function boundedLimit(url: URL, defaultValue: number): number {
  const raw = url.searchParams.get("limit");
  if (raw === null) {
    return defaultValue;
  }
  if (!/^\d+$/u.test(raw)) {
    throw new ControlPlaneStateError("limit must be an integer");
  }
  const value = Number(raw);
  if (value < 1 || value > MAX_LIST_LIMIT) {
    throw new ControlPlaneStateError(`limit must be between 1 and ${MAX_LIST_LIMIT}`);
  }
  return value;
}

function boundedOffset(url: URL): number {
  const raw = url.searchParams.get("offset");
  if (raw === null) {
    return 0;
  }
  if (!/^\d+$/u.test(raw)) {
    throw new ControlPlaneStateError("offset must be an integer");
  }
  const value = Number(raw);
  if (value > 10_000) {
    throw new ControlPlaneStateError("offset must not exceed 10000");
  }
  return value;
}

function exactQuery(url: URL, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  for (const key of url.searchParams.keys()) {
    if (!allowedKeys.has(key)) {
      throw new ControlPlaneStateError(`unknown query parameter: ${key}`);
    }
    if (url.searchParams.getAll(key).length !== 1) {
      throw new ControlPlaneStateError(`duplicate query parameter: ${key}`);
    }
  }
}

function decodeId(value: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new ControlPlaneStateError("invalid request path");
  }
  if (!decoded || decoded.length > MAX_ID_CHARS || decoded.includes("/")) {
    throw new ControlPlaneStateError("invalid request path");
  }
  return decoded;
}

function projectScope(scope: ManagedScope) {
  return {
    id: scope.id,
    kind: scope.kind,
    name: scope.name,
    ...(scope.parentScopeId ? { parentScopeId: scope.parentScopeId } : {}),
    status: scope.status,
  };
}

function projectJoinRequest(request: {
  id: string;
  scopeId: string;
  reason: string;
  status: string;
  createdAt: number;
  decidedAt?: number;
  decisionReason?: string;
}) {
  return {
    id: request.id,
    scopeId: request.scopeId,
    reason: request.reason,
    status: request.status,
    createdAt: request.createdAt,
    decidedAt: request.decidedAt,
    decisionReason: request.decisionReason,
  };
}

export class BrowserOrganizationService {
  constructor(
    private readonly options: {
      authService: BrowserAuthService;
      organization: OrganizationService;
      now?: () => number;
    },
  ) {}

  async authenticate(token: string) {
    const result = await this.options.authService.authenticateToken(token);
    return result.status === "active" ? result : null;
  }

  async context(actor: { id: string; globalRole: "member" | "admin"; displayName?: string }) {
    const snapshot = await this.options.organization.getContext(actor.id, 20);
    return {
      actor: {
        id: actor.id,
        ...(actor.displayName ? { displayName: actor.displayName } : {}),
        isAdministrator: actor.globalRole === "admin",
      },
      directMemberships: snapshot.directMemberships.map((membership) => ({
        scopeId: membership.scopeId,
        role: membership.role,
      })),
      directMembershipsHasMore: snapshot.directMembershipsHasMore,
      effectiveScopes: snapshot.effectiveAccess.map((access) => ({
        scope: projectScope(access.scope),
        source: access.source,
        ...(access.directRole ? { directRole: access.directRole } : {}),
      })),
      effectiveScopesHasMore: snapshot.effectiveAccessHasMore,
      primaryScope: snapshot.primaryScope ? projectScope(snapshot.primaryScope) : null,
      recentJoinRequests: snapshot.joinRequests.map(projectJoinRequest),
    };
  }

  async scopes(actorUserId: string, query: string, limit: number) {
    const results = await this.options.organization.searchScopesForUser(
      actorUserId,
      query,
      limit + 1,
    );
    return {
      items: results.slice(0, limit).map(({ scope, requestEligible }) => {
        const projected = projectScope(scope);
        return Object.assign(projected, { requestEligible });
      }),
      hasMore: results.length > limit,
    };
  }

  async reviewable(actorUserId: string, limit: number, offset: number) {
    const details = await this.options.organization.listReviewableRequestDetails(
      actorUserId,
      limit + 1,
      offset,
    );
    return {
      items: details.slice(0, limit).map(({ request, applicant, scope }) => ({
        request: projectJoinRequest(request),
        applicant,
        scope: projectScope(scope),
      })),
      nextOffset: details.length > limit ? offset + limit : undefined,
    };
  }

  async management(actorUserId: string, scopeId: string, limit: number, offset: number) {
    const [members, scope] = await Promise.all([
      this.options.organization.listScopeMembers(actorUserId, scopeId, limit + 1, offset),
      this.options.organization.getScope(scopeId),
    ]);
    if (!scope) {
      throw new ControlPlaneNotFoundError("managed-scope", scopeId);
    }
    return {
      scope: projectScope(scope),
      members: members.slice(0, limit).map(({ membership, user }) => ({
        user,
        role: membership.role,
        createdAt: membership.createdAt,
        updatedAt: membership.updatedAt,
      })),
      nextOffset: members.length > limit ? offset + limit : undefined,
    };
  }

  async ownRequests(actorUserId: string, limit: number, offset: number) {
    const requests = await this.options.organization.listOwnRequests(
      actorUserId,
      limit + 1,
      offset,
    );
    return {
      items: requests.slice(0, limit).map(projectJoinRequest),
      nextOffset: requests.length > limit ? offset + limit : undefined,
    };
  }

  async users(actorUserId: string, scopeId: string, query: string, limit: number) {
    const users = await this.options.organization.searchUsers(
      actorUserId,
      scopeId,
      query,
      limit + 1,
    );
    return { items: users.slice(0, limit), hasMore: users.length > limit };
  }

  async audit(actorUserId: string, limit: number, offset: number) {
    const events = await this.options.organization.listOrganizationAudit(
      actorUserId,
      limit + 1,
      offset,
    );
    return {
      items: events.slice(0, limit),
      nextOffset: events.length > limit ? offset + limit : undefined,
    };
  }

  async mutate(actorUserId: string, operation: string, body: Record<string, unknown>) {
    const now = (this.options.now ?? Date.now)();
    switch (operation) {
      case "request":
        exactKeys(body, ["scopeId", "reason"]);
        return projectJoinRequest(
          await this.options.organization.requestMembership({
            userId: actorUserId,
            scopeId: requiredString(body, "scopeId", MAX_ID_CHARS),
            reason: requiredString(body, "reason", MAX_REASON_CHARS),
            submittedAt: now,
          }),
        );
      case "primary":
        exactKeys(body, ["scopeId"]);
        return ((scope) => (scope ? projectScope(scope) : null))(
          await this.options.organization.setPrimaryScope({
            actorUserId,
            userId: actorUserId,
            scopeId: optionalNullableId(body, "scopeId"),
            changedAt: now,
          }),
        );
      case "membership-set":
        exactKeys(body, ["scopeId", "userId", "role", "reason"]);
        return await this.options.organization.assignMember({
          actorUserId,
          scopeId: requiredString(body, "scopeId", MAX_ID_CHARS),
          userId: requiredString(body, "userId", MAX_ID_CHARS),
          role: enumField<ManagedScopeRole>(body, "role", ["member", "leader"]),
          reason: requiredString(body, "reason", MAX_REASON_CHARS),
          changedAt: now,
        });
      case "membership-remove":
        exactKeys(body, ["scopeId", "userId", "reason"]);
        return {
          removed: await this.options.organization.removeMember({
            actorUserId,
            scopeId: requiredString(body, "scopeId", MAX_ID_CHARS),
            userId: requiredString(body, "userId", MAX_ID_CHARS),
            reason: requiredString(body, "reason", MAX_REASON_CHARS),
            changedAt: now,
          }),
        };
      case "scope-create": {
        exactKeys(body, ["kind", "name", "parentScopeId"]);
        const kind = enumField<ManagedScopeKind>(body, "kind", ["team", "group", "part"]);
        if (kind === "team" && body.parentScopeId !== undefined) {
          throw new ControlPlaneStateError("teams cannot have a parentScopeId");
        }
        return projectScope(
          await this.options.organization.createScope({
            actorUserId,
            kind,
            name: requiredString(body, "name", MAX_NAME_CHARS),
            ...(kind === "team"
              ? {}
              : { parentScopeId: requiredString(body, "parentScopeId", MAX_ID_CHARS) }),
            createdAt: now,
          }),
        );
      }
      default:
        throw new ControlPlaneStateError("unknown organization operation");
    }
  }

  async decide(actorUserId: string, requestId: string, body: Record<string, unknown>) {
    exactKeys(body, ["decision", "reason"]);
    return projectJoinRequest(
      await this.options.organization.decideMembershipRequest({
        actorUserId,
        requestId,
        decision: enumField(body, "decision", ["approved", "rejected"]),
        reason: requiredString(body, "reason", MAX_REASON_CHARS),
        decidedAt: (this.options.now ?? Date.now)(),
      }),
    );
  }

  async cancel(actorUserId: string, requestId: string, body: Record<string, unknown>) {
    exactKeys(body, ["reason"]);
    return projectJoinRequest(
      await this.options.organization.cancelMembershipRequest({
        actorUserId,
        requestId,
        reason: requiredString(body, "reason", MAX_REASON_CHARS),
        cancelledAt: (this.options.now ?? Date.now)(),
      }),
    );
  }

  async changeScope(actorUserId: string, scopeId: string, body: Record<string, unknown>) {
    const action = enumField(body, "action", ["rename", "archive"]);
    const now = (this.options.now ?? Date.now)();
    if (action === "rename") {
      exactKeys(body, ["action", "name", "reason"]);
      return projectScope(
        await this.options.organization.renameScope({
          actorUserId,
          scopeId,
          name: requiredString(body, "name", MAX_NAME_CHARS),
          reason: requiredString(body, "reason", MAX_REASON_CHARS),
          changedAt: now,
        }),
      );
    }
    exactKeys(body, ["action", "reason"]);
    return projectScope(
      await this.options.organization.archiveScope({
        actorUserId,
        scopeId,
        reason: requiredString(body, "reason", MAX_REASON_CHARS),
        archivedAt: now,
      }),
    );
  }
}

function sendKnownError(res: ServerResponse, error: unknown): void {
  if (error instanceof ControlPlaneAuthorizationError) {
    sendBrowserJson(res, 403, { error: "organization action not allowed" });
  } else if (error instanceof ControlPlaneNotFoundError) {
    sendBrowserJson(res, 404, { error: "organization resource not found" });
  } else if (error instanceof ControlPlaneConflictError) {
    sendBrowserJson(res, 409, { error: error.message, code: error.code });
  } else if (error instanceof ControlPlaneStateError) {
    sendBrowserJson(res, 400, { error: error.message });
  } else {
    sendBrowserJson(res, 503, { error: "organization service unavailable" });
  }
}

export async function handlePlatformClawOrganizationRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    service: BrowserOrganizationService;
    readJsonBody: JsonBodyReader;
    isMutationOriginAllowed(req: IncomingMessage): boolean;
  },
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (
    url.pathname !== PLATFORMCLAW_ORGANIZATION_PATH &&
    !url.pathname.startsWith(`${PLATFORMCLAW_ORGANIZATION_PATH}/`)
  ) {
    return false;
  }
  const token = readPlatformClawSessionCookie(req);
  const method = (req.method ?? "GET").toUpperCase();
  try {
    const auth = token ? await options.service.authenticate(token) : null;
    if (!auth) {
      sendBrowserJson(res, 401, { error: "authentication required" });
      return true;
    }
    if (method === "GET") {
      if (url.pathname === `${PLATFORMCLAW_ORGANIZATION_PATH}/context`) {
        exactQuery(url, []);
        sendBrowserJson(res, 200, await options.service.context(auth.user));
        return true;
      }
      if (url.pathname === `${PLATFORMCLAW_ORGANIZATION_PATH}/scopes`) {
        exactQuery(url, ["q", "limit"]);
        const query = url.searchParams.get("q") ?? "";
        if (query.length > MAX_QUERY_CHARS) {
          throw new ControlPlaneStateError(`q must not exceed ${MAX_QUERY_CHARS} characters`);
        }
        const limit = Math.min(boundedLimit(url, 50), 100);
        sendBrowserJson(res, 200, await options.service.scopes(auth.user.id, query, limit));
        return true;
      }
      if (url.pathname === `${PLATFORMCLAW_ORGANIZATION_PATH}/requests/reviewable`) {
        exactQuery(url, ["limit", "offset"]);
        const limit = Math.min(boundedLimit(url, 50), 100);
        sendBrowserJson(
          res,
          200,
          await options.service.reviewable(auth.user.id, limit, boundedOffset(url)),
        );
        return true;
      }
      if (url.pathname === `${PLATFORMCLAW_ORGANIZATION_PATH}/requests/own`) {
        exactQuery(url, ["limit", "offset"]);
        const limit = Math.min(boundedLimit(url, 100), 100);
        sendBrowserJson(
          res,
          200,
          await options.service.ownRequests(auth.user.id, limit, boundedOffset(url)),
        );
        return true;
      }
      if (url.pathname === `${PLATFORMCLAW_ORGANIZATION_PATH}/audit`) {
        exactQuery(url, ["limit", "offset"]);
        const limit = Math.min(boundedLimit(url, 100), 100);
        sendBrowserJson(
          res,
          200,
          await options.service.audit(auth.user.id, limit, boundedOffset(url)),
        );
        return true;
      }
      const managementMatch = new RegExp(
        `^${PLATFORMCLAW_ORGANIZATION_PATH}/management/scopes/([^/]+)$`,
        "u",
      ).exec(url.pathname);
      if (managementMatch) {
        exactQuery(url, ["limit", "offset"]);
        const limit = Math.min(boundedLimit(url, 100), 100);
        sendBrowserJson(
          res,
          200,
          await options.service.management(
            auth.user.id,
            decodeId(managementMatch[1]!),
            limit,
            boundedOffset(url),
          ),
        );
        return true;
      }
      const userSearchMatch = new RegExp(
        `^${PLATFORMCLAW_ORGANIZATION_PATH}/management/scopes/([^/]+)/users$`,
        "u",
      ).exec(url.pathname);
      if (userSearchMatch) {
        exactQuery(url, ["q", "limit"]);
        const query = url.searchParams.get("q") ?? "";
        if (query.trim().length < 2 || query.length > MAX_QUERY_CHARS) {
          throw new ControlPlaneStateError("q must contain 2-128 characters");
        }
        const limit = Math.min(boundedLimit(url, 50), 100);
        sendBrowserJson(
          res,
          200,
          await options.service.users(auth.user.id, decodeId(userSearchMatch[1]!), query, limit),
        );
        return true;
      }
    }
    if (["POST", "PUT", "PATCH"].includes(method)) {
      if (!options.isMutationOriginAllowed(req)) {
        sendBrowserJson(res, 403, { error: "origin not allowed" });
        return true;
      }
      if (
        (req.headers["content-type"] ?? "").split(";", 1)[0]?.trim().toLowerCase() !==
        "application/json"
      ) {
        sendBrowserJson(res, 415, { error: "organization mutations require application/json" });
        return true;
      }
      exactQuery(url, []);
      const read = await options.readJsonBody(req, BODY_LIMIT_BYTES);
      if (!read.ok) {
        sendBrowserJson(res, 400, { error: read.error });
        return true;
      }
      const body = objectBody(read.value);
      if (method === "POST" && url.pathname === `${PLATFORMCLAW_ORGANIZATION_PATH}/requests`) {
        sendBrowserJson(res, 200, await options.service.mutate(auth.user.id, "request", body));
        return true;
      }
      if (method === "PUT" && url.pathname === `${PLATFORMCLAW_ORGANIZATION_PATH}/primary`) {
        sendBrowserJson(res, 200, await options.service.mutate(auth.user.id, "primary", body));
        return true;
      }
      if (method === "POST" && url.pathname === `${PLATFORMCLAW_ORGANIZATION_PATH}/memberships`) {
        sendBrowserJson(
          res,
          200,
          await options.service.mutate(auth.user.id, "membership-set", body),
        );
        return true;
      }
      if (
        method === "POST" &&
        url.pathname === `${PLATFORMCLAW_ORGANIZATION_PATH}/memberships/remove`
      ) {
        sendBrowserJson(
          res,
          200,
          await options.service.mutate(auth.user.id, "membership-remove", body),
        );
        return true;
      }
      if (method === "POST" && url.pathname === `${PLATFORMCLAW_ORGANIZATION_PATH}/scopes`) {
        sendBrowserJson(res, 200, await options.service.mutate(auth.user.id, "scope-create", body));
        return true;
      }
      const decisionMatch = new RegExp(
        `^${PLATFORMCLAW_ORGANIZATION_PATH}/requests/([^/]+)/decision$`,
        "u",
      ).exec(url.pathname);
      if (method === "POST" && decisionMatch) {
        sendBrowserJson(
          res,
          200,
          await options.service.decide(auth.user.id, decodeId(decisionMatch[1]!), body),
        );
        return true;
      }
      const cancelMatch = new RegExp(
        `^${PLATFORMCLAW_ORGANIZATION_PATH}/requests/([^/]+)/cancel$`,
        "u",
      ).exec(url.pathname);
      if (method === "POST" && cancelMatch) {
        sendBrowserJson(
          res,
          200,
          await options.service.cancel(auth.user.id, decodeId(cancelMatch[1]!), body),
        );
        return true;
      }
      const scopeMatch = new RegExp(`^${PLATFORMCLAW_ORGANIZATION_PATH}/scopes/([^/]+)$`, "u").exec(
        url.pathname,
      );
      if (method === "PATCH" && scopeMatch) {
        sendBrowserJson(
          res,
          200,
          await options.service.changeScope(auth.user.id, decodeId(scopeMatch[1]!), body),
        );
        return true;
      }
    }
    res.statusCode = 405;
    res.setHeader("Allow", "GET, POST, PUT, PATCH");
    res.end("Method Not Allowed");
  } catch (error) {
    sendKnownError(res, error);
  }
  return true;
}
