import type { OrganizationAuthorization, PlatformUser } from "./contracts.js";
import type { SkillHubNamespaceBinding } from "./skill-hub-state.js";

// The managed registry provisions `global` as the company-wide namespace.
export const DEFAULT_SKILL_HUB_NAMESPACE = "global";

export type SkillHubNamespaceCapabilities = {
  canReadInstall: boolean;
  canPublish: boolean;
  canCurate: boolean;
  canOwn: boolean;
};

const DENIED: SkillHubNamespaceCapabilities = {
  canReadInstall: false,
  canPublish: false,
  canCurate: false,
  canOwn: false,
};

export function resolveSkillHubNamespaceCapabilities(params: {
  user: Pick<PlatformUser, "id" | "status" | "globalRole">;
  binding: SkillHubNamespaceBinding | null;
  organizationAuthorization?: OrganizationAuthorization;
}): SkillHubNamespaceCapabilities {
  const { binding, user } = params;
  if (!binding || binding.accessState !== "active" || user.status !== "active") {
    return DENIED;
  }
  return resolveSkillHubScopeCapabilities({
    user,
    scopeKind: binding.scopeKind,
    scopeId: binding.scopeId,
    organizationAuthorization: params.organizationAuthorization,
  });
}

export function resolveSkillHubScopeCapabilities(params: {
  user: Pick<PlatformUser, "id" | "status" | "globalRole">;
  scopeKind: SkillHubNamespaceBinding["scopeKind"];
  scopeId?: string;
  organizationAuthorization?: OrganizationAuthorization;
}): SkillHubNamespaceCapabilities {
  const { user } = params;
  if (user.status !== "active") {
    return DENIED;
  }
  if (params.scopeKind === "global") {
    const admin = user.globalRole === "admin";
    return {
      canReadInstall: true,
      canPublish: true,
      canCurate: admin,
      canOwn: true,
    };
  }
  const authorization = params.organizationAuthorization;
  if (!params.scopeId || !authorization) {
    return DENIED;
  }
  const admin = authorization.facts.source === "administrator";
  const directMember = authorization.facts.scopeIds.includes(params.scopeId);
  const canPublish = admin || authorization.canManageMembers || directMember;
  return {
    canReadInstall: authorization.canRead,
    canPublish,
    canCurate: admin || authorization.canManageMembers,
    canOwn: canPublish,
  };
}
