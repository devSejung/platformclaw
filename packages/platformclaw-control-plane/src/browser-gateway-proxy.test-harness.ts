import { vi } from "vitest";
import { BrowserAuthService, hashBrowserSessionToken } from "./browser-auth-service.js";
import { BrowserGatewayProxy, type BrowserGatewayRpc } from "./browser-gateway-proxy.js";
import type {
  ControlAuditEvent,
  ControlPlaneAuditWriter,
  EnterprisePrincipal,
  OrganizationMemorySearchHit,
  OrganizationMemoryLifecycle,
} from "./contracts.js";
import { InMemoryControlPlaneStore } from "./memory-store.js";

export const NOW = 1_000_000;

function sessionAgentId(sessionKey: string): string | null {
  const match = /^agent:([^:]+):/.exec(sessionKey.trim());
  return match?.[1] ?? null;
}

export function safeCronJob(agentId: string, extra: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    agentId,
    configRevision: "revision-1",
    owner: {
      agentId,
      sessionKey: `agent:${agentId}:main`,
      accountId: "first.user",
    },
    sessionTarget: "isolated",
    schedule: { kind: "cron", expr: "0 9 * * *" },
    payload: { kind: "agentTurn", message: "Summarize" },
    ...extra,
  };
}

export async function setupBrowserGatewayProxyTest(
  options: {
    admin?: boolean;
    searchOrganizationMemory?: (params: {
      agentId: string;
      query: string;
      maxResults?: number;
    }) => Promise<OrganizationMemorySearchHit[]>;
    organizationMemoryLifecycle?: OrganizationMemoryLifecycle;
  } = {},
) {
  let sequence = 0;
  const store = new InMemoryControlPlaneStore({
    buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
    initialAdminAccountIds: options.admin ? ["first.user"] : [],
    idFactory: {
      nextUserId: () => `user-${++sequence}`,
      nextBindingId: () => `binding-${++sequence}`,
      nextSessionId: () => `session-${++sequence}`,
      nextManagedScopeId: () => `scope-${++sequence}`,
      nextAuditEventId: () => `audit-${++sequence}`,
    },
  });
  const principal: EnterprisePrincipal = {
    provider: "ldap",
    subject: "employee-1",
    accountId: "first.user",
    employeeId: "1001",
    displayName: "First User",
    email: "first.user@example.test",
  };
  const { user } = await store.upsertPrincipal(principal, NOW);
  const reserved = await store.reservePersonalAgent(user.id, NOW);
  const binding = await store.transitionAgent({
    bindingId: reserved.binding.id,
    state: "active",
    changedAt: NOW,
  });
  if (binding.kind !== "personal") {
    throw new Error("expected personal binding");
  }
  const token = "test-token";
  const created = await store.createBrowserSession({
    userId: user.id,
    tokenHash: hashBrowserSessionToken(token),
    createdAt: NOW,
  });
  if (created.status !== "created") {
    throw new Error("expected browser session");
  }
  const service = new BrowserAuthService({
    store,
    authenticator: {
      async authenticatePassword() {
        return { status: "rejected" as const, message: "unused" };
      },
    },
    provisioner: { provisionOrRefresh: vi.fn(async () => undefined) },
    now: () => NOW,
  });
  const request = vi.fn<BrowserGatewayRpc["request"]>(async () => ({ ok: true }));
  const auditEvents: ControlAuditEvent[] = [];
  const auditWriter: ControlPlaneAuditWriter = {
    async recordAuditEvent(params) {
      const event: ControlAuditEvent = { id: `audit-${auditEvents.length + 1}`, ...params };
      auditEvents.push(event);
      return event;
    },
  };
  const proxy = new BrowserGatewayProxy({
    authService: service,
    store,
    auditWriter,
    gateway: { request },
    buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
    resolveAgentIdFromSessionKey: sessionAgentId,
    ...(options.searchOrganizationMemory
      ? { searchOrganizationMemory: options.searchOrganizationMemory }
      : {}),
    ...(options.organizationMemoryLifecycle
      ? { organizationMemoryLifecycle: options.organizationMemoryLifecycle }
      : {}),
    now: () => NOW,
  });
  return { auditEvents, binding, created, proxy, request, store, token, user };
}
