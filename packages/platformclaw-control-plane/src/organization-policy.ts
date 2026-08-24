import type {
  EffectiveManagedScopeAccess,
  ManagedScope,
  ManagedScopeMembership,
  OrganizationAuthorization,
  PlatformUser,
} from "./contracts.js";

function lineageFor(scope: ManagedScope, scopeById: ReadonlyMap<string, ManagedScope>) {
  const lineage: ManagedScope[] = [];
  const seen = new Set<string>();
  let current: ManagedScope | undefined = scope;
  while (current) {
    if (seen.has(current.id)) {
      return [];
    }
    seen.add(current.id);
    lineage.push(current);
    if (!current.parentScopeId) {
      current = undefined;
      continue;
    }
    const parent = scopeById.get(current.parentScopeId);
    if (!parent) {
      return [];
    }
    current = parent;
  }
  return lineage;
}

export function isDelegatedOrganizationLeader(params: {
  targetScope: ManagedScope;
  scopes: readonly ManagedScope[];
  memberships: readonly ManagedScopeMembership[];
}): boolean {
  const scopeById = new Map(params.scopes.map((scope) => [scope.id, scope]));
  const lineage = lineageFor(params.targetScope, scopeById);
  if (lineage.length === 0 || lineage.some((scope) => scope.status !== "active")) {
    return false;
  }
  const leaderScopeIds = new Set(
    params.memberships
      .filter((membership) => membership.role === "leader")
      .map((membership) => membership.scopeId),
  );
  return lineage.some((scope) => leaderScopeIds.has(scope.id));
}

export function prepareOrganizationAuthorizationContext(params: {
  actor: PlatformUser | null;
  scopes: readonly ManagedScope[];
  memberships: readonly ManagedScopeMembership[];
}): { authorize: (targetScope: ManagedScope | null) => OrganizationAuthorization } {
  const unavailable: OrganizationAuthorization = {
    canRead: false,
    canManageMembers: false,
    canManageStructure: false,
    canManageLeaders: false,
    facts: { source: "none", scopeIds: [] },
  };
  const scopeById = new Map(params.scopes.map((scope) => [scope.id, scope]));
  const membershipByScope = new Map(params.memberships.map((entry) => [entry.scopeId, entry]));
  const readableTargets = new Map<string, string[]>();
  for (const membership of params.memberships) {
    const membershipScope = scopeById.get(membership.scopeId);
    if (!membershipScope) {
      continue;
    }
    const lineage = lineageFor(membershipScope, scopeById);
    if (lineage.length === 0 || lineage.some((scope) => scope.status !== "active")) {
      continue;
    }
    for (const scope of lineage) {
      const sources = readableTargets.get(scope.id) ?? [];
      sources.push(membership.scopeId);
      readableTargets.set(scope.id, sources);
    }
  }
  return {
    authorize(targetScope) {
      const { actor } = params;
      if (!actor || actor.status !== "active" || !targetScope) {
        return unavailable;
      }
      const targetLineage = lineageFor(targetScope, scopeById);
      if (targetLineage.length === 0 || targetLineage.some((scope) => scope.status !== "active")) {
        return unavailable;
      }
      if (actor.globalRole === "admin") {
        return {
          canRead: true,
          canManageMembers: true,
          canManageStructure: true,
          canManageLeaders: true,
          facts: { source: "administrator", scopeIds: [targetScope.id] },
        };
      }
      const leaderScopeIds = targetLineage
        .filter((scope) => membershipByScope.get(scope.id)?.role === "leader")
        .map((scope) => scope.id);
      const readScopeIds = (readableTargets.get(targetScope.id) ?? []).toSorted();
      const canManageMembers = leaderScopeIds.length > 0;
      const canRead = readScopeIds.length > 0;
      return {
        canRead,
        canManageMembers,
        canManageStructure: false,
        canManageLeaders: false,
        facts: {
          source: canManageMembers ? "leadership" : canRead ? "membership" : "none",
          scopeIds: canManageMembers ? leaderScopeIds : readScopeIds,
        },
      };
    },
  };
}

export function resolveOrganizationAuthorization(params: {
  actor: PlatformUser | null;
  targetScope: ManagedScope | null;
  scopes: readonly ManagedScope[];
  memberships: readonly ManagedScopeMembership[];
}): OrganizationAuthorization {
  return prepareOrganizationAuthorizationContext(params).authorize(params.targetScope);
}

export function resolveEffectiveOrganizationAccess(params: {
  user: PlatformUser | null;
  scopes: readonly ManagedScope[];
  memberships: readonly ManagedScopeMembership[];
}): EffectiveManagedScopeAccess[] {
  if (!params.user || params.user.status !== "active") {
    return [];
  }
  const scopeById = new Map(params.scopes.map((scope) => [scope.id, scope]));
  if (params.user.globalRole === "admin") {
    return params.scopes
      .filter((scope) => {
        const lineage = lineageFor(scope, scopeById);
        return lineage.length > 0 && lineage.every((entry) => entry.status === "active");
      })
      .map((scope) => ({ scope, source: "administrator" as const }));
  }
  const access = new Map<string, EffectiveManagedScopeAccess>();
  for (const membership of params.memberships) {
    const directScope = scopeById.get(membership.scopeId);
    if (!directScope) {
      continue;
    }
    const lineage = lineageFor(directScope, scopeById);
    if (lineage.length === 0 || lineage.some((scope) => scope.status !== "active")) {
      continue;
    }
    lineage.forEach((scope, index) => {
      const candidate: EffectiveManagedScopeAccess =
        index === 0
          ? { scope, source: "direct", directRole: membership.role }
          : { scope, source: "ancestor" };
      if (!access.has(scope.id) || candidate.source === "direct") {
        access.set(scope.id, candidate);
      }
    });
  }
  return [...access.values()].toSorted((left, right) =>
    left.scope.id.localeCompare(right.scope.id),
  );
}
