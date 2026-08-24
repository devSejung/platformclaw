import type { OrganizationAuthorization, PlatformUser } from "./contracts.js";
import type { SkillHubNamespaceBinding } from "./skill-hub-state.js";

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
  if (binding.scopeKind === "global") {
    const admin = user.globalRole === "admin";
    return {
      canReadInstall: true,
      canPublish: admin,
      canCurate: admin,
      canOwn: admin,
    };
  }
  const authorization = params.organizationAuthorization;
  if (!binding.scopeId || !authorization) {
    return DENIED;
  }
  const admin = authorization.facts.source === "administrator";
  const directMember = authorization.facts.scopeIds.includes(binding.scopeId);
  const canPublish = admin || authorization.canManageMembers || directMember;
  return {
    canReadInstall: authorization.canRead,
    canPublish,
    canCurate: admin || authorization.canManageMembers,
    canOwn: canPublish,
  };
}
