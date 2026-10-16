import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, vi } from "vitest";
import { BrowserAuthService, hashBrowserSessionToken } from "./browser-auth-service.js";
import { readBrowserJsonBody } from "./browser-http-shared.js";
import {
  handlePlatformClawSkillHubRequest,
  PLATFORMCLAW_SKILL_HUB_PATH,
} from "./browser-skill-hub-http.js";
import type { EnterprisePrincipal } from "./contracts.js";
import type { GatewayAdminRpc } from "./gateway-admin-rpc-client.js";
import { OrganizationService } from "./organization-service.js";
import { SkillHubAdapterError, type SkillHubAdapter } from "./skill-hub-adapter.js";
import {
  SkillHubGovernanceError,
  type SkillHubEditableMetadata,
  type SkillHubGovernanceClient,
  type SkillHubRegistryEdit,
} from "./skill-hub-governance-client.js";
import { SkillHubService } from "./skill-hub-service.js";
import { SqliteControlPlaneStore } from "./sqlite-store.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
});

function registryFixture(privateVersions = false) {
  let metadata: SkillHubEditableMetadata = {
    id: 10,
    namespace: "source",
    slug: "demo",
    revision: "revision-1",
    displayName: "Original demo",
    summary: "Original summary",
    visibility: privateVersions ? "PRIVATE" : "NAMESPACE_ONLY",
    effectiveVisibility: privateVersions ? "PRIVATE" : "NAMESPACE_ONLY",
    reviewVersions: [],
  };
  const receipts = new Map<string, SkillHubEditableMetadata>();
  let commits = 0;
  let unavailable = false;
  let loseNextResponse = false;
  let rejectNext: number | undefined;
  let scansReady = false;
  let losePrivacyResponse = false;
  let privacyUnavailable = false;
  let conflictPrivacy = false;
  let beforeEdit: (() => Promise<void>) | undefined;
  const requireSkill = (namespace: string, slug: string) => {
    if (metadata.namespace !== namespace || metadata.slug !== slug) {
      throw new SkillHubAdapterError("Skill not found", 404);
    }
    return { ...metadata };
  };
  const editSkill = vi.fn(async (edit: SkillHubRegistryEdit) => {
    if (unavailable || (privacyUnavailable && edit.visibility === "PRIVATE")) {
      throw new SkillHubGovernanceError("Registry temporarily unavailable");
    }
    const receipt = receipts.get(edit.operationId);
    if (receipt) {
      return { ...receipt };
    }
    if (rejectNext) {
      const status = rejectNext;
      rejectNext = undefined;
      throw new SkillHubGovernanceError("Registry internal rejection details", status);
    }
    if (conflictPrivacy && edit.visibility === "PRIVATE") {
      conflictPrivacy = false;
      metadata = { ...metadata, revision: metadata.revision + "-native-approval" };
    }
    if (edit.expectedRevision !== metadata.revision || edit.skillId !== metadata.id) {
      throw new SkillHubGovernanceError("Revision conflict", 409);
    }
    const action = beforeEdit;
    beforeEdit = undefined;
    await action?.();
    commits += 1;
    const reviewVersions =
      edit.visibility === "PRIVATE"
        ? []
        : versions
            .filter((version) => version.status !== "PUBLISHED")
            .map((version) => version.version);
    const published = versions.some((version) => version.status === "PUBLISHED");
    metadata = {
      id: metadata.id,
      namespace: edit.targetNamespace,
      slug: metadata.slug,
      revision: `revision-${commits + 1}`,
      displayName: edit.displayName,
      summary: edit.summary,
      visibility: edit.visibility,
      effectiveVisibility:
        edit.visibility !== "PRIVATE" && !published ? "PRIVATE" : edit.visibility,
      reviewVersions,
    };
    receipts.set(edit.operationId, { ...metadata });
    if (loseNextResponse || (losePrivacyResponse && edit.visibility === "PRIVATE")) {
      loseNextResponse = false;
      losePrivacyResponse = false;
      unavailable = true;
      throw new SkillHubGovernanceError("Connection lost after commit");
    }
    return { ...metadata };
  });
  const governance: SkillHubGovernanceClient = {
    getEditableSkill: async (namespace, slug) => requireSkill(namespace, slug),
    editSkill,
    approvePendingReview: async ({ version }) => {
      const selected = versions.find((candidate) => candidate.version === version);
      if (!selected) {
        throw new SkillHubGovernanceError("Review version was not found", 404);
      }
      selected.status = "PUBLISHED";
      metadata = { ...metadata, effectiveVisibility: metadata.visibility };
      return { reviewId: selected.id, status: "APPROVED" };
    },
  };
  const versions = [
    {
      id: 12,
      version: "2.0.0",
      status: privateVersions ? "UPLOADED" : "PUBLISHED",
      downloadAvailable: true,
    },
    {
      id: 11,
      version: "1.0.0",
      status: privateVersions ? "SCANNING" : "PUBLISHED",
      downloadAvailable: true,
    },
  ];
  const publish = vi.fn(async () => {
    throw new Error("Unexpected registry publication");
  });
  const download = vi.fn<SkillHubAdapter["download"]>(async () => {
    throw new Error("Unpublished versions must not reach download");
  });
  const adapter: SkillHubAdapter = {
    search: async () => ({
      items: [
        {
          namespace: metadata.namespace,
          slug: metadata.slug,
          latestVersion: "2.0.0",
          summary: metadata.summary,
          visibility: metadata.effectiveVisibility,
        },
      ],
      total: 1,
    }),
    getSkill: async (namespace, slug) => ({
      ...requireSkill(namespace, slug),
      visibility: metadata.effectiveVisibility,
      status: "PUBLISHED",
    }),
    listVersions: async (namespace, slug) => {
      requireSkill(namespace, slug);
      return versions.map((version) => ({ ...version }));
    },
    getVersionState: async (namespace, slug, version) => {
      requireSkill(namespace, slug);
      const selected = versions.find((candidate) => candidate.version === version);
      if (!selected) {
        throw new SkillHubAdapterError("Version not found", 404);
      }
      return { ...selected };
    },
    listSecurityAudits: async () =>
      scansReady
        ? [
            {
              scannerType: "SKILL_SCANNER",
              verdict: "SAFE",
              isSafe: true,
              scannedAt: "2026-10-16T00:00:00Z",
            },
          ]
        : [{ scannerType: "SKILL_SCANNER", verdict: "SUSPICIOUS", isSafe: false }],
    publish,
    deleteSkill: async () => {
      throw new Error("Unexpected deletion");
    },
    download,
  };
  return {
    adapter,
    governance,
    editSkill,
    publish,
    download,
    versions,
    get commits() {
      return commits;
    },
    loseResponse() {
      loseNextResponse = true;
    },
    resume() {
      unavailable = false;
      privacyUnavailable = false;
    },
    losePrivacyResponse() {
      losePrivacyResponse = true;
    },
    pausePrivacy() {
      privacyUnavailable = true;
    },
    conflictPrivacy() {
      conflictPrivacy = true;
    },
    get metadata() {
      return { ...metadata };
    },
    reject(status = 409) {
      rejectNext = status;
    },
    beforeEdit(callback: () => Promise<void>) {
      beforeEdit = callback;
    },
    passScans() {
      scansReady = true;
      for (const version of versions) {
        if (version.status !== "PUBLISHED") {
          version.status = "PENDING_REVIEW";
        }
      }
    },
  };
}

export async function createSkillHubEditHttpFixture(privateVersions = false) {
  const directory = mkdtempSync(path.join(tmpdir(), "platformclaw-skill-edit-http-"));
  const databasePath = path.join(directory, "control.sqlite");
  const workspaceRoot = path.join(directory, "workspaces");
  const now = Date.now();
  const registry = registryFixture(privateVersions);
  const createStore = () =>
    new SqliteControlPlaneStore({
      databasePath,
      initialAdminAccountIds: ["admin.user"],
      buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
    });
  let store = createStore();
  const users = new Map<
    string,
    Awaited<ReturnType<SqliteControlPlaneStore["upsertPrincipal"]>>["user"]
  >();
  for (const name of ["admin", "owner", "outsider", "viewer"]) {
    const principal: EnterprisePrincipal = {
      provider: "ldap",
      subject: `${name}.user`,
      accountId: `${name}.user`,
      employeeId: `employee-${name}`,
      groups: [],
    };
    const { user } = await store.upsertPrincipal(principal, now);
    users.set(name, user);
    const reservation = await store.reservePersonalAgent(user.id, now);
    await store.transitionAgent({
      bindingId: reservation.binding.id,
      state: "active",
      changedAt: now,
    });
    await store.createBrowserSession({
      userId: user.id,
      tokenHash: hashBrowserSessionToken(`${name}-token`),
      createdAt: now,
    });
    const skillDirectory = path.join(workspaceRoot, reservation.binding.agentId, "skills", "demo");
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(
      path.join(skillDirectory, "SKILL.md"),
      "---\nname: demo\ndescription: Demo\nversion: 2.0.0\n---\nInstructions\n",
    );
  }
  const admin = users.get("admin")!;
  const owner = users.get("owner")!;
  const outsider = users.get("outsider")!;
  const scopes = new Map<string, string>();
  for (const namespace of ["source", "target", "denied", "limited"]) {
    const scope = await store.createManagedScope({
      actorUserId: admin.id,
      kind: "team",
      name: namespace,
      createdAt: now,
    });
    scopes.set(namespace, scope.id);
    if (namespace !== "denied") {
      await store.setManagedScopeMembership({
        actorUserId: admin.id,
        scopeId: scope.id,
        userId: owner.id,
        role: "member",
        reason: "fixture membership",
        changedAt: now,
      });
    }
    await store.setSkillHubNamespaceBinding({
      namespace,
      scopeKind: "team",
      scopeId: scope.id,
      accessState: "active",
      visibilityCeiling: namespace === "limited" ? "PRIVATE" : "PUBLIC",
      expectedUpdatedAt: null,
      reason: "fixture namespace",
      actorUserId: admin.id,
      changedAt: now,
    });
  }
  const ownership = await store.recordSkillHubPublication({
    namespace: "source",
    slug: "demo",
    ownerUserId: owner.id,
    expectedOwnerUserId: null,
    expectedOwnerUpdatedAt: null,
    expectedBindingUpdatedAt: now,
    visibility: privateVersions ? "PRIVATE" : "NAMESPACE_ONLY",
    version: "2.0.0",
    changedAt: now,
  });
  await store.setSkillHubAccess({
    namespace: "source",
    slug: "demo",
    userId: outsider.id,
    grantedByUserId: owner.id,
    inheritVersions: false,
    grantedVersion: "1.0.0",
    expiresAt: now + 60_000,
    changedAt: now,
  });
  const rpcCall = vi.fn<GatewayAdminRpc["call"]>(async () => {
    throw new Error("Pending edit must prevent Gateway mutation");
  });
  const rpc: GatewayAdminRpc = {
    call: async <T>(method: string, params: unknown) => (await rpcCall(method, params)) as T,
  };
  const createService = () =>
    new SkillHubService({
      store,
      organization: new OrganizationService(store),
      adapter: registry.adapter,
      governance: registry.governance,
      adminRpc: rpc,
      authService: new BrowserAuthService({
        store,
        authenticator: {
          authenticatePassword: async () => ({ status: "rejected", message: "unused" }),
        },
        provisioner: { provisionOrRefresh: async () => undefined },
        now: () => now + 100,
      }),
      workspaceRoot,
      allowedNamespaces: ["source", "target", "denied", "limited"],
      maxPackageBytes: 1024 * 1024,
      now: () => now + 100,
      buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
    });
  let service = createService();
  const server = createServer((req, res) => {
    void handlePlatformClawSkillHubRequest(req, res, {
      service,
      readJsonBody: readBrowserJsonBody,
      isMutationOriginAllowed: (request) => request.headers.origin === "http://platformclaw.test",
    }).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("HTTP fixture failed to listen");
  }
  const baseUrl = `http://127.0.0.1:${address.port}${PLATFORMCLAW_SKILL_HUB_PATH}`;
  cleanups.push(async () => {
    service.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const request = async (user: string, route: string, body?: unknown) => {
    const response = await fetch(`${baseUrl}${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        cookie: `platformclaw_session=${user}-token`,
        origin: "http://platformclaw.test",
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const edit = {
    operationId: randomUUID(),
    namespace: "target",
    displayName: "Edited demo",
    summary: "Updated summary",
    visibility: "NAMESPACE_ONLY",
    expectedOwnerUpdatedAt: ownership.updatedAt,
    expectedRegistryRevision: "revision-1",
  };
  return {
    databasePath,
    registry,
    request,
    edit,
    owner,
    admin,
    outsider,
    scopes,
    rpcCall,
    get store() {
      return store;
    },
    get service() {
      return service;
    },
    restart() {
      service.close();
      store.close();
      store = createStore();
      service = createService();
    },
  };
}
