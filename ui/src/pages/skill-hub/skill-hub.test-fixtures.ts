import type {
  PlatformClawSkillHubConfig,
  PlatformClawSkillHubDetail,
  PlatformClawSkillHubSearchItem,
} from "../../platformclaw/skill-hub.ts";

export function skillHubConfig(
  overrides: Partial<PlatformClawSkillHubConfig> = {},
): PlatformClawSkillHubConfig {
  return {
    defaultSharing: "PUBLIC",
    scopes: [],
    ownedSkills: [],
    limits: { iconBytes: 2097152, tags: 5, tagChars: 32 },
    maxPackageBytes: 1024 * 1024,
    maxUploadBytes: 500 * 1024 * 1024,
    activeTarget: "platform_server",
    admin: false,
    installTargets: [
      { target: "platform_server", available: true, status: "ready" },
      { target: "assigned_vm", available: true, status: "ready" },
    ],
    ...overrides,
  };
}

export function skillHubEntry(
  overrides: Partial<PlatformClawSkillHubSearchItem> = {},
): PlatformClawSkillHubSearchItem {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "demo",
    displayName: "Demo",
    summary: "A useful skill",
    tags: [],
    iconUrl: null,
    sharing: { mode: "PUBLIC" },
    revision: 7,
    latestVersion: "1.0.0",
    owner: {
      assigned: true,
      isMine: true,
      unassigned: false,
      revision: 7,
      user: { id: "employee-one", accountId: "person.one", displayName: "Person One" },
    },
    ...overrides,
  };
}

export function skillHubDetail(
  overrides: Partial<PlatformClawSkillHubDetail> = {},
): PlatformClawSkillHubDetail {
  const entry = skillHubEntry();
  return {
    skill: entry,
    owner: entry.owner,
    canManage: true,
    sharing: { mode: "PUBLIC", userIds: [], scopeIds: [], users: [], scopes: [] },
    versions: [{ version: "1.0.0", status: "PUBLISHED", downloadAvailable: true }],
    scanner: { status: "passed", badge: "Scan passed", current: true },
    ...overrides,
  };
}

export function skillHubJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function skillHubRequestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}
export function skillHubRequestBody(body: RequestInit["body"]): string {
  if (typeof body !== "string") {
    throw new Error("Expected a JSON string request body");
  }
  return body;
}
