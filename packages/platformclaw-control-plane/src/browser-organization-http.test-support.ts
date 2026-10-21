import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import type { BrowserAuthService } from "./browser-auth-service.js";
import {
  BrowserOrganizationService,
  handlePlatformClawOrganizationRequest,
} from "./browser-organization-http.js";
import type { ControlPlaneIdFactory, EnterprisePrincipal, PlatformUser } from "./contracts.js";
import { OrganizationService } from "./organization-service.js";
import { SqliteControlPlaneStore } from "./sqlite-store.js";

const directories: string[] = [];
let sequence = 0;

function ids(): ControlPlaneIdFactory {
  const next = (kind: string) => `${kind}-${++sequence}`;
  return {
    nextUserId: () => next("user"),
    nextBindingId: () => next("binding"),
    nextSessionId: () => next("session"),
    nextManagedScopeId: () => next("scope"),
    nextAuditEventId: () => next("audit"),
  };
}

export function principal(accountId: string, displayName = accountId): EnterprisePrincipal {
  return {
    provider: "ldap",
    subject: accountId,
    accountId,
    employeeId: `employee-${accountId}`,
    displayName,
    email: `${accountId}@example.test`,
    department: "Private department",
    groups: ["private-directory-group"],
  };
}

export function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), "platformclaw-organization-http-"));
  directories.push(directory);
  const store = new SqliteControlPlaneStore({
    databasePath: join(directory, "control.sqlite"),
    buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
    initialAdminAccountIds: ["admin"],
    idFactory: ids(),
  });
  const users = new Map<string, PlatformUser>();
  let clock = 1_000;
  const authService = {
    authenticateToken: vi.fn(async (token: string) => {
      const user = users.get(token);
      return user ? { status: "active", user } : { status: "not-found" };
    }),
  } as unknown as BrowserAuthService;
  return {
    store,
    users,
    organization: new OrganizationService(store),
    service: new BrowserOrganizationService({
      authService,
      organization: new OrganizationService(store),
      now: () => clock++,
    }),
  };
}

function responseHarness(): { response: ServerResponse; body(): unknown } {
  let responseBody = "";
  return {
    response: {
      statusCode: 200,
      setHeader: vi.fn(),
      end: (body?: unknown) => {
        responseBody = typeof body === "string" ? body : "";
      },
    } as unknown as ServerResponse,
    body: () => (responseBody ? (JSON.parse(responseBody) as unknown) : undefined),
  };
}

export async function call(
  service: BrowserOrganizationService,
  params: {
    method?: string;
    path: string;
    token?: string;
    body?: Record<string, unknown>;
    originAllowed?: boolean;
    contentType?: string | null;
  },
) {
  const harness = responseHarness();
  const request = {
    url: params.path,
    method: params.method ?? "GET",
    headers: {
      ...(params.token ? { cookie: `platformclaw_session=${params.token}` } : {}),
      ...(params.contentType === null
        ? {}
        : { "content-type": params.contentType ?? "application/json" }),
    },
  } as unknown as IncomingMessage;
  await handlePlatformClawOrganizationRequest(request, harness.response, {
    service,
    isMutationOriginAllowed: () => params.originAllowed ?? true,
    readJsonBody: async () => ({ ok: true, value: params.body ?? {} }),
  });
  return { status: harness.response.statusCode, body: harness.body() };
}

export function cleanupOrganizationHttpFixtures(): void {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
}
