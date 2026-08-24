import { randomUUID } from "node:crypto";
import type {
  ControlPlaneManagementStore,
  ControlPlaneStore,
  EffectiveManagedScopeAccess,
  ManagedScope,
  ManagedScopeRole,
  OrganizationAuthorization,
  OrganizationJoinRequest,
} from "./contracts.js";

type OrganizationStore = ControlPlaneManagementStore & Pick<ControlPlaneStore, "getUserById">;

export class AuthorizationService {
  constructor(private readonly store: OrganizationStore) {}

  async authorizeManagedScope(
    actorUserId: string,
    scopeId: string,
  ): Promise<OrganizationAuthorization> {
    return this.store.resolveManagedScopeAuthorization(actorUserId, scopeId);
  }

  async listEffectiveAccess(userId: string): Promise<EffectiveManagedScopeAccess[]> {
    return this.store.listEffectiveManagedScopeAccess(userId);
  }
}

export class OrganizationService {
  readonly authorization: AuthorizationService;

  constructor(
    private readonly store: OrganizationStore,
    private readonly nextRequestId: () => string = () => `organization-request-${randomUUID()}`,
  ) {
    this.authorization = new AuthorizationService(store);
  }

  createScope(params: {
    actorUserId: string;
    kind: ManagedScope["kind"];
    name: string;
    parentScopeId?: string;
    createdAt: number;
  }): Promise<ManagedScope> {
    return this.store.createManagedScope(params);
  }

  assignMember(params: {
    actorUserId: string;
    scopeId: string;
    userId: string;
    role: ManagedScopeRole;
    reason: string;
    changedAt: number;
  }) {
    return this.store.setManagedScopeMembership(params);
  }

  archiveScope(params: Parameters<ControlPlaneManagementStore["archiveManagedScope"]>[0]) {
    return this.store.archiveManagedScope(params);
  }

  removeMember(params: Parameters<ControlPlaneManagementStore["removeManagedScopeMembership"]>[0]) {
    return this.store.removeManagedScopeMembership(params);
  }

  setPrimaryScope(params: Parameters<ControlPlaneManagementStore["setUserPrimaryScope"]>[0]) {
    return this.store.setUserPrimaryScope(params);
  }

  listScopes() {
    return this.store.listManagedScopes();
  }

  getScopeLineage(scopeId: string) {
    return this.store.getManagedScopeLineage(scopeId);
  }

  async listOwnRequests(userId: string, limit = 100): Promise<OrganizationJoinRequest[]> {
    const bounded = Number.isFinite(limit) ? Math.max(1, Math.min(Math.trunc(limit), 200)) : 100;
    return this.store.listOwnOrganizationJoinRequests({ userId, limit: bounded });
  }

  async listReviewableRequests(
    actorUserId: string,
    limit = 100,
  ): Promise<OrganizationJoinRequest[]> {
    const bounded = Number.isFinite(limit) ? Math.max(1, Math.min(Math.trunc(limit), 200)) : 100;
    return this.store.listReviewableOrganizationJoinRequests({
      actorUserId,
      limit: bounded,
    });
  }

  requestMembership(params: {
    userId: string;
    scopeId: string;
    reason: string;
    submittedAt: number;
  }): Promise<OrganizationJoinRequest> {
    return this.store.submitOrganizationJoinRequest({
      ...params,
      requestId: this.nextRequestId(),
    });
  }

  decideMembershipRequest(
    params: Parameters<ControlPlaneManagementStore["decideOrganizationJoinRequest"]>[0],
  ) {
    return this.store.decideOrganizationJoinRequest(params);
  }

  cancelMembershipRequest(
    params: Parameters<ControlPlaneManagementStore["cancelOrganizationJoinRequest"]>[0],
  ) {
    return this.store.cancelOrganizationJoinRequest(params);
  }
}
