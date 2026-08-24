import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { BrowserAuthService } from "./browser-auth-service.js";
import type { ControlPlaneStore, OrganizationAuthorization, PlatformUser } from "./contracts.js";
import type { ControlPlaneExecutionManagementStore } from "./execution-contracts.js";
import type { GatewayAdminRpc } from "./gateway-admin-rpc-client.js";
import type { OrganizationService } from "./organization-service.js";
import type { SkillHubAdapter } from "./skill-hub-adapter.js";
import type { SkillHubGovernanceClient } from "./skill-hub-governance-client.js";
import type { SkillHubStore } from "./skill-hub-service-support.js";
import { SkillHubService } from "./skill-hub-service.js";
import type { SkillHubNamespaceBinding, SkillHubOwnership } from "./skill-hub-state.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

export const skillHubTestUser: PlatformUser = {
  id: "user-1",
  accountId: "person.one",
  employeeId: "1001",
  status: "active",
  globalRole: "member",
  groups: ["engineering"],
  createdAt: 1,
  updatedAt: 1,
};

export async function createSkillHubServiceFixture(
  groups: string[] = ["engineering"],
  governance?: SkillHubGovernanceClient,
) {
  const user = skillHubTestUser;
  const workspaceRoot = tempDirs.make("platformclaw-skill-hub-");
  const skillDir = path.join(workspaceRoot, "agent-1", "skills", "demo-skill");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    "---\nname: demo-skill\ndescription: Demo skill\nversion: 0.0.1\n---\nInstructions\n",
  );
  await writeFile(path.join(skillDir, "helper.txt"), "hello");

  const authenticateToken = vi.fn(async () => ({
    status: "active" as const,
    session: {
      id: "session-1",
      userId: user.id,
      tokenHash: "hash",
      createdAt: 1,
      lastSeenAt: 1,
      idleExpiresAt: 2,
      absoluteExpiresAt: 2,
    },
    user: { ...user, groups },
  }));
  const recordAuditEvent = vi.fn(async (params) => ({ id: "audit-1", ...params }));
  const getPersonalExecutionProfile = vi.fn<ControlPlaneStore["getPersonalExecutionProfile"]>(
    async () => null,
  );
  const getVmAllocationForAgent = vi.fn<
    ControlPlaneExecutionManagementStore["getVmAllocationForAgent"]
  >(async () => null);
  let ownership: SkillHubOwnership | null = null;
  const getSkillHubNamespaceBinding = vi.fn<() => Promise<SkillHubNamespaceBinding | null>>(
    async () => ({
      namespace: "engineering",
      scopeKind: "team" as const,
      scopeId: "scope-1",
      accessState: "active" as const,
      visibilityCeiling: "PUBLIC" as const,
      createdByUserId: "admin-1",
      createdAt: 1,
      updatedAt: 1,
    }),
  );
  const store = {
    getPersonalExecutionProfile,
    getPersonalAgentBinding: vi.fn(async () => ({
      id: "binding-1",
      kind: "personal" as const,
      userId: user.id,
      agentId: "agent-1",
      state: "active" as const,
      createdAt: 1,
      updatedAt: 1,
    })),
    resolveAuthenticatedKnoxDmRoute: vi.fn(async () => ({
      status: "resolved" as const,
      user: { ...user, groups },
      binding: {
        id: "binding-1",
        kind: "personal" as const,
        userId: user.id,
        agentId: "agent-1",
        state: "active" as const,
        createdAt: 1,
        updatedAt: 1,
      },
      sessionKey: "agent:agent-1:main",
      executionTarget: "platform_server" as const,
    })),
    getVmAllocationForAgent,
    getUserById: vi.fn(async (userId: string) => ({ ...user, id: userId, accountId: userId })),
    getSkillHubOwnership: vi.fn(async () => ownership),
    recordSkillHubPublication: vi.fn(async (params) => {
      ownership = {
        namespace: params.namespace,
        slug: params.slug,
        ownerUserId: ownership?.ownerUserId ?? params.ownerUserId,
        visibility: params.visibility,
        currentVersion: params.version,
        updatedAt: params.changedAt,
      };
      return ownership;
    }),
    reconcileInactiveSkillHubOwners: vi.fn(async () => ({ reassigned: 0, unassigned: 0 })),
    hasSkillHubAccess: vi.fn(async () => false),
    listSkillHubAccess: vi.fn(async () => []),
    setSkillHubAccess: vi.fn(async (params) => ({
      namespace: params.namespace,
      slug: params.slug,
      userId: params.userId,
      grantedByUserId: params.grantedByUserId,
      expiresAt: params.expiresAt,
      inheritVersions: params.inheritVersions,
      grantedVersion: params.grantedVersion,
      canReshare: false as const,
      createdAt: params.changedAt,
      updatedAt: params.changedAt,
    })),
    removeSkillHubAccess: vi.fn(async () => true),
    searchSkillHubManagementUsers: vi.fn(async () => []),
    transferSkillHubOwner: vi.fn(async (params) => ({
      namespace: params.namespace,
      slug: params.slug,
      ownerUserId: params.ownerUserId,
      previousOwnerUserId: params.expectedOwnerUserId ?? undefined,
      visibility: "PRIVATE" as const,
      currentVersion: "1.0.0",
      updatedAt: params.changedAt,
    })),
    countUnreadSkillHubNotifications: vi.fn(async () => 0),
    countUnassignedSkillHubSkills: vi.fn(async () => 0),
    listUnassignedSkillHubSkills: vi.fn(async () => []),
    getSkillHubNamespaceBinding,
    listSkillHubNamespaceBindings: vi.fn(async () => []),
    setSkillHubNamespaceBinding: vi.fn(async (params) => ({
      namespace: params.namespace,
      scopeKind: params.scopeKind,
      scopeId: params.scopeId,
      accessState: params.accessState,
      visibilityCeiling: params.visibilityCeiling,
      createdByUserId: params.actorUserId,
      createdAt: params.changedAt,
      updatedAt: params.changedAt,
    })),
    setSkillHubNamespaceAccessState: vi.fn(async (params) => ({
      namespace: params.namespace,
      scopeKind: "global" as const,
      accessState: params.accessState,
      visibilityCeiling: "NAMESPACE_ONLY" as const,
      createdByUserId: params.actorUserId,
      createdAt: 1,
      updatedAt: params.changedAt,
    })),
    enqueueSkillHubGovernanceJob: vi.fn(async () => undefined),
    listDueSkillHubGovernanceJobs: vi.fn(async () => []),
    updateSkillHubGovernanceJob: vi.fn(async () => undefined),
    createSkillHubNotification: vi.fn(async (params) => ({
      id: "notification-1",
      kind: params.kind,
      message: params.message,
      createdAt: params.createdAt,
    })),
    recordAuditEvent,
  } as unknown as SkillHubStore;
  const adapterMocks = {
    search: vi.fn<SkillHubAdapter["search"]>(async () => ({ items: [], total: 0 })),
    getSkill: vi.fn(async () => ({
      id: 10,
      namespace: "engineering",
      slug: "demo-skill",
      displayName: "Demo Skill",
      summary: "Demo",
      visibility: "PUBLIC",
      status: "PUBLISHED",
    })),
    listVersions: vi.fn<SkillHubAdapter["listVersions"]>(async () => []),
    listSecurityAudits: vi.fn<SkillHubAdapter["listSecurityAudits"]>(async () => []),
    publish: vi.fn(async (params) => ({
      namespace: params.namespace,
      slug: "demo-skill",
      version: "1.2.3",
      visibility: params.visibility,
    })),
    download: vi.fn(),
  };
  const adapter = adapterMocks as SkillHubAdapter;
  const adminRpcCall = vi.fn();
  const adminRpc = { call: adminRpcCall } as unknown as GatewayAdminRpc;
  const authorizeManagedScope = vi.fn<
    (actorUserId: string, scopeId: string) => Promise<OrganizationAuthorization>
  >(async () => ({
    canRead: true,
    canManageMembers: false,
    canManageStructure: false,
    canManageLeaders: false,
    facts: { source: "membership" as const, scopeIds: ["scope-1"] },
  }));
  const organization = {
    authorization: { authorizeManagedScope },
    listScopes: vi.fn(async () => []),
  } as unknown as OrganizationService;
  const service = new SkillHubService({
    authService: { authenticateToken } as unknown as BrowserAuthService,
    store,
    adapter,
    adminRpc,
    workspaceRoot,
    allowedNamespaces: ["engineering"],
    organization,
    maxPackageBytes: 1024 * 1024,
    now: () => 100,
    ...(governance ? { governance } : {}),
  });
  const actor = await service.authenticate("session-token");
  if (!actor) {
    throw new Error("fixture authentication failed");
  }
  return {
    workspaceRoot,
    store,
    skillDir,
    service,
    actor,
    adapterMocks,
    adminRpcCall,
    recordAuditEvent,
    getPersonalExecutionProfile,
    getVmAllocationForAgent,
    organization,
    authorizeManagedScope,
    getSkillHubNamespaceBinding,
  };
}
