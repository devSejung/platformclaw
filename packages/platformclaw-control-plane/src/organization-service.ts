import { randomUUID } from "node:crypto";
import type {
  ControlPlaneManagementStore,
  EffectiveManagedScopeAccess,
  ManagedScope,
  ManagedScopeRole,
  OrganizationAuthorization,
  OrganizationAuditCursor,
  OrganizationJoinRequest,
} from "./contracts.js";

type OrganizationStore = ControlPlaneManagementStore;

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
    expectedRole?: ManagedScopeRole | null;
    reason: string;
    changedAt: number;
  }) {
    return this.store.setManagedScopeMembership(params);
  }

  archiveScope(params: Parameters<ControlPlaneManagementStore["archiveManagedScope"]>[0]) {
    return this.store.archiveManagedScope(params);
  }

  renameScope(params: Parameters<ControlPlaneManagementStore["renameManagedScope"]>[0]) {
    return this.store.renameManagedScope(params);
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

  searchScopesForUser(userId: string, query: string, limit = 50) {
    const bounded = Number.isFinite(limit) ? Math.max(1, Math.min(Math.trunc(limit), 101)) : 50;
    return this.store.searchOrganizationScopesForUser({ userId, query, limit: bounded });
  }

  getScope(scopeId: string) {
    return this.store.getManagedScope(scopeId);
  }

  async listScopeMembers(actorUserId: string, scopeId: string, limit = 100, offset = 0) {
    const bounded = Number.isFinite(limit) ? Math.max(1, Math.min(Math.trunc(limit), 200)) : 100;
    const boundedOffset = Number.isFinite(offset)
      ? Math.max(0, Math.min(Math.trunc(offset), 10_000))
      : 0;
    return await this.store.listAuthorizedManagedScopeMembers({
      actorUserId,
      scopeId,
      limit: bounded,
      offset: boundedOffset,
    });
  }

  async searchUsers(actorUserId: string, scopeId: string, query: string, limit = 50) {
    const bounded = Number.isFinite(limit) ? Math.max(1, Math.min(Math.trunc(limit), 101)) : 50;
    return await this.store.searchAuthorizedOrganizationUsers({
      actorUserId,
      scopeId,
      query,
      limit: bounded,
    });
  }

  async listOrganizationAudit(
    actorUserId: string,
    limit = 50,
    cursor?: OrganizationAuditCursor,
    category?: "scope" | "membership" | "primary" | "join" | "other",
    outcome?: "succeeded" | "denied",
  ) {
    const bounded = Number.isFinite(limit) ? Math.max(1, Math.min(Math.trunc(limit), 100)) : 50;
    return await this.store.listAuthorizedOrganizationAuditEvents({
      actorUserId,
      limit: bounded,
      cursor,
      category,
      outcome,
    });
  }

  getScopeLineage(scopeId: string) {
    return this.store.getManagedScopeLineage(scopeId);
  }

  async listOwnRequests(
    userId: string,
    limit = 100,
    offset = 0,
  ): Promise<OrganizationJoinRequest[]> {
    const bounded = Number.isFinite(limit) ? Math.max(1, Math.min(Math.trunc(limit), 200)) : 100;
    const boundedOffset = Number.isFinite(offset)
      ? Math.max(0, Math.min(Math.trunc(offset), 10_000))
      : 0;
    return this.store.listOwnOrganizationJoinRequests({
      userId,
      limit: bounded,
      offset: boundedOffset,
    });
  }

  async listOwnRequestDetails(userId: string, limit = 100, offset = 0) {
    const bounded = Number.isFinite(limit) ? Math.max(1, Math.min(Math.trunc(limit), 200)) : 100;
    return await this.store.listOwnOrganizationJoinRequestDetails({
      userId,
      limit: bounded,
      offset: Math.max(0, Math.min(Math.trunc(offset), 10_000)),
    });
  }

  async getContext(userId: string, requestLimit = 20) {
    const bounded = Number.isFinite(requestLimit)
      ? Math.max(1, Math.min(Math.trunc(requestLimit), 50))
      : 20;
    return await this.store.getOrganizationContextSnapshot({ userId, requestLimit: bounded });
  }

  async listReviewableRequests(
    actorUserId: string,
    limit = 100,
    offset = 0,
  ): Promise<OrganizationJoinRequest[]> {
    const bounded = Number.isFinite(limit) ? Math.max(1, Math.min(Math.trunc(limit), 200)) : 100;
    return this.store.listReviewableOrganizationJoinRequests({
      actorUserId,
      limit: bounded,
      offset: Math.max(0, Math.min(Math.trunc(offset), 10_000)),
    });
  }

  async listReviewableRequestDetails(actorUserId: string, limit = 100, offset = 0) {
    const bounded = Number.isFinite(limit) ? Math.max(1, Math.min(Math.trunc(limit), 200)) : 100;
    return await this.store.listReviewableOrganizationJoinRequestDetails({
      actorUserId,
      limit: bounded,
      offset: Math.max(0, Math.min(Math.trunc(offset), 10_000)),
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
