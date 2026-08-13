import { PLATFORMCLAW_SKILL_HUB_API_PATH } from "./web-contract.ts";

export type PlatformClawSkillHubConfig = {
  namespaces: string[];
  maxPackageBytes: number;
};

export type PlatformClawSkillHubSearchItem = {
  namespace: string;
  slug: string;
  latestVersion: string;
  summary: string;
};

export type PlatformClawSkillHubVersion = {
  version: string;
  status: string;
  changelog?: string;
  fileCount?: number;
  totalSize?: number;
  publishedAt?: string;
  downloadAvailable: boolean;
};

export type PlatformClawSkillHubDetail = {
  skill: Record<string, unknown>;
  versions: PlatformClawSkillHubVersion[];
};

export type PlatformClawSkillHubMessage = { kind: "success" | "error"; text: string };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${PLATFORMCLAW_SKILL_HUB_API_PATH}${path}`, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json", ...init.headers } : init?.headers,
  });
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  if (!response.ok) {
    throw new Error(
      typeof body?.error === "string"
        ? body.error
        : `Skill Hub request failed (${response.status})`,
    );
  }
  return body as T;
}

export function loadPlatformClawSkillHubConfig(): Promise<PlatformClawSkillHubConfig> {
  return request("/config");
}

export function searchPlatformClawSkillHub(
  query: string,
): Promise<{ items: PlatformClawSkillHubSearchItem[]; total: number }> {
  return request(`/search?q=${encodeURIComponent(query)}&limit=20`);
}

export function loadPlatformClawSkillHubDetail(
  namespace: string,
  slug: string,
): Promise<PlatformClawSkillHubDetail> {
  return request(`/skills/${encodeURIComponent(namespace)}/${encodeURIComponent(slug)}`);
}

export function publishPlatformClawWorkspaceSkill(params: {
  skill: string;
  namespace: string;
  version: string;
  visibility: string;
}): Promise<{ namespace: string; slug: string; version: string }> {
  return request("/publish", { method: "POST", body: JSON.stringify(params) });
}

export function installPlatformClawHubSkill(params: {
  namespace: string;
  slug: string;
  version: string;
}): Promise<Record<string, unknown>> {
  return request("/install", { method: "POST", body: JSON.stringify(params) });
}
