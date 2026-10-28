import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { BrowserAuthService, hashBrowserSessionToken } from "./browser-auth-service.js";
import { testHostKey } from "./execution-store.test-support.js";
import type { GatewayAdminRpc } from "./gateway-admin-rpc-client.js";
import { OrganizationService } from "./organization-service.js";
import {
  SkillHubAdapterError,
  type SkillHubAdapter,
  type SkillHubSkillDetail,
} from "./skill-hub-adapter.js";
import type { SkillHubSharing } from "./skill-hub-catalog-state.js";
import type { SkillHubGovernanceClient } from "./skill-hub-governance-client.js";
import { projectSkillHubScan } from "./skill-hub-scan-policy.js";
import type { AuthenticatedWorkspace } from "./skill-hub-service-support.js";
import { SkillHubService } from "./skill-hub-service.js";
import { SqliteControlPlaneStore } from "./sqlite-store.js";

const tempDirs = createTempDirTracker();
const resources: Array<{ service: SkillHubService; store: SqliteControlPlaneStore }> = [];
afterEach(() => {
  for (const { service, store } of resources.splice(0)) {
    service.close();
    store.close();
  }
  tempDirs.cleanup();
});
export async function createSkillHubServiceFixture(
  groups: string[] = [],
  governance?: Partial<SkillHubGovernanceClient>,
  options: { registrySkill?: "absent" | "existing"; now?: () => number } = {},
) {
  const workspaceRoot = tempDirs.make("platformclaw-skill-hub-");
  let userId = 0;
  let bindingId = 0;
  let sessionId = 0;
  let scopeId = 0;
  let auditId = 0;
  const store = new SqliteControlPlaneStore({
    databasePath: path.join(workspaceRoot, "control.sqlite"),
    initialAdminAccountIds: ["admin.user"],
    buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
    idFactory: {
      nextUserId: () => `user-${++userId}`,
      nextBindingId: () => `binding-${++bindingId}`,
      nextSessionId: () => `session-${++sessionId}`,
      nextManagedScopeId: () => `scope-${++scopeId}`,
      nextAuditEventId: () => `audit-${++auditId}`,
    },
  });
  await store.skillHubCatalog.finishMigration(1);
  const authService = new BrowserAuthService({
    store,
    now: () => 100,
    authenticator: {
      authenticatePassword: async () => ({ status: "rejected", message: "Unused fixture login" }),
    },
    provisioner: { provisionOrRefresh: async () => undefined },
  });
  const createActor = async (
    accountId: string,
    actorGroups: string[] = [],
  ): Promise<AuthenticatedWorkspace & { token: string }> => {
    const { user } = await store.upsertPrincipal(
      {
        provider: "ldap",
        subject: accountId,
        accountId,
        employeeId: accountId,
        groups: actorGroups,
      },
      1,
    );
    const { binding } = await store.reservePersonalAgent(user.id, 1);
    await store.transitionAgent({ bindingId: binding.id, state: "active", changedAt: 2 });
    const token = accountId === "person.one" ? "session-token" : `session-${accountId}`;
    await store.createBrowserSession({
      userId: user.id,
      tokenHash: hashBrowserSessionToken(token),
      createdAt: 3,
    });
    const workspaceDir = path.join(workspaceRoot, binding.agentId);
    await mkdir(path.join(workspaceDir, "skills"), { recursive: true });
    return { user, agentId: binding.agentId, workspaceDir, token };
  };
  const actor = await createActor("person.one", groups);
  const skillDir = path.join(actor.workspaceDir, "skills", "demo-skill");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    "---\nname: demo-skill\ndescription: Demo skill\nversion: 0.0.1\n---\nInstructions\n",
  );
  await writeFile(path.join(skillDir, "helper.txt"), "hello");
  const getPersonalExecutionProfile = vi.spyOn(store, "getPersonalExecutionProfile");
  const getVmAllocationForAgent = vi.spyOn(store, "getVmAllocationForAgent");
  let vmSetup: Promise<{ endpointId: string; adminUserId: string }> | undefined;
  let vmCount = 0;
  const saveVm = async (owner = actor) => {
    vmSetup ??= (async () => {
      const adminUser =
        (await store.getUserByAccountId("admin.user")) ?? (await createActor("admin.user")).user;
      const endpoint = await store.createSafeConnectEndpoint({
        actorUserId: adminUser.id,
        label: "Fixture SafeConnect",
        host: "safeconnect.example.test",
        port: 44_422,
        adDomain: "example.test",
        createdAt: 4,
      });
      await store.approveSafeConnectHostKey({
        actorUserId: adminUser.id,
        endpointId: endpoint.id,
        ...testHostKey,
        approvedAt: 5,
      });
      return { endpointId: endpoint.id, adminUserId: adminUser.id };
    })();
    const setup = await vmSetup;
    const index = ++vmCount;
    const host = await store.createVmHost({
      actorUserId: setup.adminUserId,
      endpointId: setup.endpointId,
      label: `Fixture VM ${index}`,
      targetAddress: `192.0.2.${index}`,
      createdAt: 6,
    });
    const identity = { actorUserId: owner.user.id, agentId: owner.agentId };
    const candidate = await store.preparePersonalVmCandidate({
      ...identity,
      vmHostId: host.id,
      linuxAccount: "fixture-user",
    });
    const profile = await store.getPersonalExecutionProfile(owner.agentId);
    if (!profile) {
      throw new Error("VM fixture requires a personal execution profile");
    }
    return await store.savePersonalVmConnection({
      ...identity,
      vmHostId: host.id,
      linuxAccount: "fixture-user",
      candidate,
      remoteHomeDir: `/home/fixture-vm${index}`,
      remoteWorkspaceDir: `/home/fixture-vm${index}/workspace`,
      credentialEnvelope: {
        ciphertext: new Uint8Array([index]),
        nonce: new Uint8Array(12),
        authTag: new Uint8Array(16),
        keyId: `sha256:${"A".repeat(43)}`,
        formatVersion: 1,
      },
      expectedRevision: profile.targetRevision,
      verifiedAt: 7,
    });
  };
  const activateVm = async (connectionId: string, owner = actor) => {
    const profile = await store.getPersonalExecutionProfile(owner.agentId);
    const connection = (
      await store.getPersonalSavedVmConnections({
        actorUserId: owner.user.id,
        agentId: owner.agentId,
      })
    ).find((item) => item.id === connectionId);
    if (!profile || !connection) {
      throw new Error("Saved VM fixture is unavailable");
    }
    const target = await store.activatePersonalVmConnection({
      agentId: owner.agentId,
      connectionId,
      expectedRevision: profile.targetRevision,
      expectedConnectionRevision: connection.revision,
      changedAt: 8 + profile.targetRevision,
    });
    if (target.kind !== "assigned_vm") {
      throw new Error("Saved VM fixture did not activate");
    }
    return target;
  };
  const recordAuditEvent = vi.spyOn(store, "recordAuditEvent");
  const native = new Map<string, SkillHubSkillDetail & { managedPublicationId?: string }>();
  const nativeVersions = new Map<string, Set<string>>();
  let nativeId = 9;
  const seedEntry = async (
    params: {
      ownerUserId?: string;
      sharing?: SkillHubSharing;
      slug?: string;
      version?: string;
    } = {},
  ) => {
    const operationId = randomUUID();
    const { entry } = await store.skillHubCatalog.reservePublication({
      operationId,
      actorUserId: params.ownerUserId ?? actor.user.id,
      slug: params.slug ?? "demo-skill",
      version: params.version ?? "1.0.0",
      fingerprint: operationId,
      summary: "Demo",
      displayName: "Demo Skill",
      sharing: params.sharing,
      now: 10,
    });
    const id = ++nativeId;
    const key = `${entry.namespace}/${entry.slug}`;
    native.set(key, {
      id,
      namespace: entry.namespace,
      slug: entry.slug,
      displayName: entry.displayName,
      summary: entry.summary,
      visibility: "PRIVATE",
      status: "PUBLISHED",
      managedPublicationId: entry.id,
    });
    nativeVersions.set(key, new Set([params.version ?? "1.0.0", "2.0.0"]));
    return await store.skillHubCatalog.completePublication({
      operationId,
      registryId: id,
      now: 11,
    });
  };
  const entry = options.registrySkill === "absent" ? null : await seedEntry();
  const adapterMocks = {
    search: vi.fn<SkillHubAdapter["search"]>(async () => ({ items: [], total: 0 })),
    getSkill: vi.fn<SkillHubAdapter["getSkill"]>(async (namespace, slug) => {
      const value = native.get(`${namespace}/${slug}`);
      if (!value) {
        throw new SkillHubAdapterError("Skill Hub skill not found", 404);
      }
      return value;
    }),
    listVersions: vi.fn<SkillHubAdapter["listVersions"]>(async (namespace, slug) =>
      [...(nativeVersions.get(`${namespace}/${slug}`) ?? [])].map((version, index) => ({
        id: index + 20,
        version,
        status: "PUBLISHED",
        downloadAvailable: true,
      })),
    ),
    getVersionState: vi.fn<SkillHubAdapter["getVersionState"]>(
      async (_namespace, _slug, version) => ({ id: 20, version, status: "PUBLISHED" }),
    ),
    listSecurityAudits: vi.fn<SkillHubAdapter["listSecurityAudits"]>(async () => []),
    deleteSkill: vi.fn<SkillHubAdapter["deleteSkill"]>(async (namespace, slug) => {
      native.delete(`${namespace}/${slug}`);
      return { ok: true, namespace, slug };
    }),
    download: vi.fn<SkillHubAdapter["download"]>(),
  } satisfies SkillHubAdapter;
  const installed = new Map<string, { slug: string; version: string; revision: string }>();
  const uploads = new Map<string, Buffer>();
  let nextUpload = 0;
  const gatewayCall = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (
      (method === "skills.status" || method === "skills.install") &&
      typeof params.agentId !== "string"
    ) {
      throw new Error("Fixture requires Agent identity");
    }
    const agentId = typeof params.agentId === "string" ? params.agentId : "";
    const target =
      params.backendTarget === "assigned_vm"
        ? (await store.resolvePersonalExecutionTarget(agentId, "assigned_vm")).targetId
        : "platform-server";
    if (method === "skills.status") {
      const value = installed.get(`${agentId}/${target}`);
      return {
        skills: value
          ? [
              {
                skillKey: value.slug,
                version: value.version,
                revision: value.revision,
                source:
                  params.backendTarget === "assigned_vm"
                    ? "platformclaw-vm-workspace"
                    : "openclaw-workspace",
                baseDir: `/workspace/skills/${value.slug}`,
              },
            ]
          : [],
      };
    }
    if (method === "skills.uninstall") {
      installed.delete(`${agentId}/${target}`);
      return { ok: true, slug: params.slug };
    }
    if (method === "skills.upload.begin") {
      return { uploadId: `upload-${++nextUpload}`, receivedBytes: 0 };
    }
    if (method === "skills.upload.chunk") {
      const id = String(params.uploadId);
      const previous = uploads.get(id) ?? Buffer.alloc(0);
      uploads.set(
        id,
        Buffer.concat([
          previous.subarray(0, Number(params.offset)),
          Buffer.from(String(params.dataBase64), "base64"),
        ]),
      );
      return { ok: true };
    }
    if (method === "skills.install") {
      const bytes = uploads.get(String(params.uploadId));
      if (!bytes) {
        throw new Error("Fixture Gateway install needs uploaded archive bytes");
      }
      const markdown = await (await JSZip.loadAsync(bytes)).file("SKILL.md")!.async("string");
      const version = /^version:\s*(.+)$/mu.exec(markdown)?.[1]?.trim();
      if (!version) {
        throw new Error("Fixture Gateway received invalid version");
      }
      installed.set(`${agentId}/${target}`, {
        slug: String(params.slug),
        version,
        revision: `sha256:${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}`,
      });
      return { ok: true, slug: params.slug };
    }
    return { ok: true };
  };
  const adminRpcCall =
    vi.fn<(method: string, params: Record<string, unknown>) => Promise<unknown>>(gatewayCall);
  const adminRpc: GatewayAdminRpc = {
    // The service owns validation of dynamically typed Gateway JSON responses.
    async call<T>(method: string, params: unknown): Promise<T> {
      if (!params || typeof params !== "object" || Array.isArray(params)) {
        throw new Error("Invalid fixture RPC parameters");
      }
      return (await adminRpcCall(method, params as Record<string, unknown>)) as T;
    },
  };
  const organization = new OrganizationService(store);
  const deletions = new Map<
    number,
    import("./skill-hub-governance-client.js").SkillHubArtifactDeletion
  >();
  const governanceMocks = {
    reserveArtifactIdentity: vi.fn<SkillHubGovernanceClient["reserveArtifactIdentity"]>(
      async (params) => {
        await params.revalidateAuthority();
        const key = `${params.namespace}/${params.slug}`;
        const existing = native.get(key);
        if (existing) {
          if (existing.managedPublicationId !== params.publicationId) {
            throw new SkillHubAdapterError("Native publication origin changed", 409);
          }
          return existing;
        }
        const reserved: SkillHubSkillDetail & { managedPublicationId: string } = {
          id: ++nativeId,
          namespace: params.namespace,
          slug: params.slug,
          displayName: "",
          summary: "",
          visibility: "PRIVATE",
          status: "ACTIVE",
          managedPublicationId: params.publicationId,
        };
        native.set(key, reserved);
        return reserved;
      },
    ),
    getArtifactSkill: vi.fn<SkillHubGovernanceClient["getArtifactSkill"]>(async (identity) => {
      const value = await adapterMocks.getSkill(identity.namespace, identity.slug);
      if (identity.expectedSkillId !== undefined && value.id !== identity.expectedSkillId) {
        throw new SkillHubAdapterError("Native artifact identity changed", 409);
      }
      if (
        identity.expectedPublicationId !== undefined &&
        native.get(`${identity.namespace}/${identity.slug}`)?.managedPublicationId !==
          identity.expectedPublicationId
      ) {
        throw new SkillHubAdapterError("Native publication origin changed", 409);
      }
      return value;
    }),
    listArtifactVersions: vi.fn<SkillHubGovernanceClient["listArtifactVersions"]>(
      async (identity) => {
        if (native.get(`${identity.namespace}/${identity.slug}`)?.id !== identity.skillId) {
          throw new SkillHubAdapterError("Native artifact identity changed", 409);
        }
        return (await adapterMocks.listVersions(identity.namespace, identity.slug)).map(
          ({ downloadAvailable: _downloadAvailable, ...version }) => version,
        );
      },
    ),
    publishArtifact: vi.fn<SkillHubGovernanceClient["publishArtifact"]>(async (params) => {
      await params.revalidateAuthority();
      const bytes = Buffer.isBuffer(params.archive)
        ? params.archive
        : await readFile(params.archive.path);
      const markdown = await (await JSZip.loadAsync(bytes)).file("SKILL.md")!.async("string");
      const slug = /^name:\s*(.+)$/mu.exec(markdown)?.[1]?.trim();
      const version = /^version:\s*(.+)$/mu.exec(markdown)?.[1]?.trim();
      if (!slug || !version) {
        throw new Error("Fixture adapter received invalid package");
      }
      const key = `${params.namespace}/${slug}`;
      const existing = native.get(key);
      if (!existing || params.expectedSkillId !== existing.id) {
        throw new Error("Fixture native publication identity mismatch");
      }
      if (nativeVersions.get(key)?.has(version)) {
        throw new Error("Fixture native publication cannot replace an immutable version");
      }
      const skillId = existing.id;
      native.set(key, {
        id: skillId,
        namespace: params.namespace,
        slug,
        displayName: existing?.displayName ?? slug,
        summary: existing?.summary ?? "Demo",
        visibility: existing?.visibility ?? "PRIVATE",
        status: "PUBLISHED",
        managedPublicationId: existing?.managedPublicationId ?? params.namespace.slice(3),
      });
      const versions = nativeVersions.get(key) ?? new Set<string>();
      versions.add(version);
      nativeVersions.set(key, versions);
      return { skillId, namespace: params.namespace, slug, version };
    }),
    createNamespace: vi.fn<NonNullable<SkillHubGovernanceClient["createNamespace"]>>(
      async ({ namespace }) => ({ id: 1, namespace }),
    ),
    getArtifactSecurity: vi.fn<SkillHubGovernanceClient["getArtifactSecurity"]>(
      async (identity) => {
        const actual = native.get(`${identity.namespace}/${identity.slug}`);
        if (actual?.id !== identity.skillId) {
          throw new Error("Native artifact identity mismatch");
        }
        const audits = await adapterMocks.listSecurityAudits(identity.skillId, identity.versionId);
        return { audits, artifactAvailable: true, blocked: projectSkillHubScan(audits).blocked };
      },
    ),
    downloadArtifact: vi.fn<SkillHubGovernanceClient["downloadArtifact"]>(async (identity) => {
      const actual = native.get(`${identity.namespace}/${identity.slug}`);
      if (actual?.id !== identity.skillId) {
        throw new Error("Native artifact identity mismatch");
      }
      const versions = await adapterMocks.listVersions(identity.namespace, identity.slug);
      const version = versions.find((item) => item.id === identity.versionId);
      if (!version) {
        throw new Error("Native artifact version mismatch");
      }
      return await adapterMocks.download(identity.namespace, identity.slug, version.version);
    }),
    deleteArtifact: vi.fn<SkillHubGovernanceClient["deleteArtifact"]>(async (identity) => {
      const receipt = deletions.get(identity.skillId);
      if (receipt) {
        return receipt;
      }
      const actual = native.get(`${identity.namespace}/${identity.slug}`);
      if (actual?.id !== identity.skillId) {
        throw new Error("Native artifact identity mismatch");
      }
      const result = await adapterMocks.deleteSkill(identity.namespace, identity.slug);
      if (!result.ok || result.namespace !== identity.namespace || result.slug !== identity.slug) {
        throw new Error("Native deletion is unconfirmed");
      }
      const completed = {
        skillId: identity.skillId,
        state: "completed" as const,
        completedAt: new Date(100).toISOString(),
      };
      deletions.set(identity.skillId, completed);
      return completed;
    }),
    getArtifactDeletion: vi.fn<SkillHubGovernanceClient["getArtifactDeletion"]>(
      async (skillId) => deletions.get(skillId) ?? null,
    ),
  };
  const service = new SkillHubService({
    authService,
    store,
    adminRpc,
    workspaceRoot,
    buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
    organization,
    maxPackageBytes: 1024 * 1024,
    now: options.now ?? (() => 100),
    governance: {
      ...governanceMocks,
      ...governance,
    },
  });
  resources.push({ service, store });
  const authenticated = await service.authenticate("session-token");
  if (!authenticated) {
    throw new Error("Fixture authentication failed");
  }
  return {
    workspaceRoot,
    store,
    authService,
    skillDir,
    service,
    actor: { ...authenticated, token: actor.token },
    entry,
    seedEntry,
    createActor,
    adapterMocks,
    adminRpcCall,
    gatewayCall,
    recordAuditEvent,
    getPersonalExecutionProfile,
    getVmAllocationForAgent,
    saveVm,
    activateVm,
    organization,
    native,
    nativeVersions,
    uploads,
    installed,
    governanceMocks,
    deletions,
  };
}
