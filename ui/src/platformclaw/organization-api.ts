const PLATFORMCLAW_ORGANIZATION_API_PATH = "/platformclaw/api/organization";

export type OrganizationScopeKind = "team" | "group" | "part";
export type OrganizationMemberRole = "member" | "leader";

type OrganizationScope = {
  id: string;
  kind: OrganizationScopeKind;
  name: string;
  parentScopeId?: string;
  status: "active" | "archived";
  revision?: number;
};

type OrganizationScopeCapabilities = {
  canManageMembers: boolean;
  canManageStructure: boolean;
  canManageLeaders: boolean;
};

export type OrganizationScopeResult = OrganizationScope & {
  revision: number;
  lineage: OrganizationScope[];
  capabilities: OrganizationScopeCapabilities;
  requestEligible: boolean;
};

export type OrganizationContext = {
  actor: { id: string; displayName?: string; isAdministrator: boolean };
  directMemberships: Array<{ scopeId: string; role: OrganizationMemberRole }>;
  directMembershipsHasMore: boolean;
  directScopeLineages: Array<{ scopeId: string; lineage: OrganizationScope[] }>;
  effectiveScopes: Array<{
    scope: OrganizationScope;
    source: "direct" | "ancestor" | "administrator";
    directRole?: OrganizationMemberRole;
  }>;
  effectiveScopesHasMore: boolean;
  primaryScope: OrganizationScope | null;
  primaryScopeLineage: OrganizationScope[];
};

type OrganizationMember = {
  user: { id: string; accountId: string; displayName?: string; status: "active" | "disabled" };
  role: OrganizationMemberRole;
};

export type OrganizationManagement = {
  scope: OrganizationScope;
  members: OrganizationMember[];
  nextOffset?: number;
};

export type OrganizationUserSearch = {
  items: Array<{
    id: string;
    accountId: string;
    displayName?: string;
    status: "active" | "disabled";
    currentRole?: OrganizationMemberRole;
  }>;
  hasMore: boolean;
};

export class PlatformClawOrganizationApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

type OrganizationApiOptions = {
  fetchImpl: typeof fetch;
  onUnauthenticated: () => void;
};

export class PlatformClawOrganizationApi {
  constructor(private readonly options: OrganizationApiOptions) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.options.fetchImpl(`${PLATFORMCLAW_ORGANIZATION_API_PATH}${path}`, {
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
      },
      ...init,
    });
    if (response.status === 401) {
      this.options.onUnauthenticated();
    }
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
      code?: string;
    };
    if (!response.ok) {
      throw new PlatformClawOrganizationApiError(
        body.error ?? "Organization request failed",
        response.status,
        body.code,
      );
    }
    return body as T;
  }

  context(): Promise<OrganizationContext> {
    return this.request("/context");
  }

  scopes(query = "", limit = 100): Promise<{ items: OrganizationScopeResult[]; hasMore: boolean }> {
    const search = new URLSearchParams({ q: query, limit: String(limit) });
    return this.request(`/scopes?${search}`);
  }

  management(scopeId: string, offset = 0): Promise<OrganizationManagement> {
    return this.request(
      `/management/scopes/${encodeURIComponent(scopeId)}?limit=100&offset=${offset}`,
    );
  }

  users(scopeId: string, query: string): Promise<OrganizationUserSearch> {
    const search = new URLSearchParams({ q: query, limit: "50" });
    return this.request(`/management/scopes/${encodeURIComponent(scopeId)}/users?${search}`);
  }

  setPrimary(scopeId: string | null): Promise<OrganizationScope | null> {
    return this.request("/primary", {
      method: "PUT",
      body: JSON.stringify({ scopeId }),
    });
  }

  setMembership(params: {
    scopeId: string;
    userId: string;
    role: OrganizationMemberRole;
    expectedRole: OrganizationMemberRole | null;
    reason: string;
  }): Promise<unknown> {
    return this.request("/memberships", { method: "POST", body: JSON.stringify(params) });
  }

  removeMembership(params: {
    scopeId: string;
    userId: string;
    expectedRole: OrganizationMemberRole;
    reason: string;
  }): Promise<{ removed: boolean }> {
    return this.request("/memberships/remove", {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  createScope(params: {
    kind: OrganizationScopeKind;
    name: string;
    parentScopeId?: string;
  }): Promise<OrganizationScope> {
    return this.request("/scopes", { method: "POST", body: JSON.stringify(params) });
  }

  changeScope(
    scopeId: string,
    body:
      | { action: "rename"; expectedRevision: number; name: string; reason: string }
      | { action: "archive"; expectedRevision: number; reason: string },
  ): Promise<OrganizationScope> {
    return this.request(`/scopes/${encodeURIComponent(scopeId)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  }
}
