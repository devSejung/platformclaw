import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page, Route } from "playwright";
import { PLATFORMCLAW_WEB_GATEWAY_METHODS } from "../../../packages/platformclaw-control-plane/src/browser-gateway-policy.ts";
import { skillHubConfig, skillHubEntry } from "../pages/skill-hub/skill-hub.test-fixtures.ts";
import type {
  PlatformClawSkillHubConfig,
  PlatformClawSkillHubWorkspaceSkill,
  PlatformClawSkillHubWorkspaceTarget,
} from "../platformclaw/skill-hub.ts";
import { PLATFORMCLAW_WEB_DESCRIPTOR } from "../platformclaw/web-contract.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";

const installationProofDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "skill-hub-installation",
);
export function fixtureSkillId(slug: string): string {
  return slug === "release-checklist"
    ? "11111111-1111-4111-8111-111111111111"
    : "22222222-2222-4222-8222-222222222222";
}
function entry(slug: string) {
  return skillHubEntry({
    id: fixtureSkillId(slug),
    slug,
    displayName: slug === "release-checklist" ? "Release checklist" : "Incident guide",
    latestVersion: "2.3.0",
    summary: "Choose where to install this skill. Each workspace has its own copy.",
  });
}
export async function screenshotInstallation(page: Page, name: string) {
  await mkdir(installationProofDir, { recursive: true });
  await page.screenshot({ animations: "disabled", path: path.join(installationProofDir, name) });
}
export async function installSkillHubFixture(page: Page, baseUrl: string) {
  const response = await page.request.get(baseUrl);
  const source = await response.text();
  await page.route("**/platformclaw/app/**", (route) =>
    route.fulfill({
      body: source.replace(
        "</head>",
        `<meta name="platformclaw-web-descriptor" content='${JSON.stringify(PLATFORMCLAW_WEB_DESCRIPTOR)}'></head>`,
      ),
      headers: response.headers(),
      status: response.status(),
    }),
  );
  await page.route("**/platformclaw/api/auth/session", (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        user: {
          accountId: "person.one",
          displayName: "Person One",
          department: "Platform Lab",
          globalRole: "member",
        },
        agent: { agentId: "person_one", state: "active" },
        session: { idleExpiresAt: Date.now() + 60000, absoluteExpiresAt: Date.now() + 120000 },
      },
    }),
  );
  const config = skillHubConfig({ activeTarget: "assigned_vm" });
  const inventories: Record<
    PlatformClawSkillHubWorkspaceTarget,
    PlatformClawSkillHubWorkspaceSkill[]
  > = {
    platform_server: [],
    assigned_vm: [
      {
        skillKey: "release-checklist",
        version: "2.3.0",
        revision: "vm-r1",
        hubSkillId: fixtureSkillId("release-checklist"),
        hubVersion: "2.3.0",
      },
    ],
  };
  const reads: string[] = [];
  const installs: Array<Record<string, unknown>> = [];
  const executionMutations: string[] = [];
  const controls: {
    config: PlatformClawSkillHubConfig;
    inventories: typeof inventories;
    reads: string[];
    installs: typeof installs;
    executionMutations: string[];
    inventoryHook?: (route: Route, target: string | null) => Promise<boolean>;
    detailHook?: (route: Route, slug: string) => Promise<boolean>;
  } = { config, inventories, reads, installs, executionMutations };
  await page.route("**/platformclaw/api/execution", (route) => {
    if (route.request().method() !== "GET") {
      executionMutations.push(route.request().method());
    }
    return route.fulfill({
      json: {
        accountId: "person.one",
        activeTarget: "assigned_vm",
        assignment: { vmHostId: "vm-one", status: "ready" },
        credentialStatus: "current",
        availableVms: [],
        savedVms: [],
        targetRevision: 1,
      },
    });
  });
  await page.route("**/platformclaw/api/skill-hub/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/config")) {
      return route.fulfill({ json: config });
    }
    if (url.pathname.endsWith("/search")) {
      return route.fulfill({
        json: { total: 2, items: [entry("release-checklist"), entry("incident-guide")] },
      });
    }
    if (url.pathname.endsWith("/workspace-skills")) {
      const target = url.searchParams.get("source");
      reads.push(target ?? "missing");
      if (await controls.inventoryHook?.(route, target)) {
        return;
      }
      return route.fulfill({
        json: { source: target, items: inventories[target as PlatformClawSkillHubWorkspaceTarget] },
      });
    }
    if (url.pathname.endsWith("/install")) {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      const id = url.pathname.split("/").at(-2)!;
      const slug =
        id === fixtureSkillId("release-checklist") ? "release-checklist" : "incident-guide";
      installs.push({ ...body, id });
      const target = body.destination as PlatformClawSkillHubWorkspaceTarget;
      const current = inventories[target].find((skill) => skill.skillKey === slug);
      if (current && !body.acknowledgedReplacement) {
        return route.fulfill({
          status: 409,
          json: {
            error: "Confirm replacement of the installed version.",
            details: {
              code: "existing-skill-replacement-required",
              currentVersion: current.version,
              currentRevision: current.revision,
              requestedVersion: body.version,
              direction: "downgrade",
            },
          },
        });
      }
      inventories[target] = [
        {
          skillKey: slug,
          version: String(body.version),
          revision: `${target}-r2`,
          hubSkillId: id,
          hubVersion: String(body.version),
        },
      ];
      return route.fulfill({ json: { ok: true, slug, version: body.version, target } });
    }
    const id = url.pathname.split("/").at(-1)!;
    const slug =
      id === fixtureSkillId("release-checklist") ? "release-checklist" : "incident-guide";
    if (await controls.detailHook?.(route, slug)) {
      return;
    }
    return route.fulfill({
      json: {
        skill: entry(slug),
        owner: entry(slug).owner,
        canManage: false,
        versions: [
          { version: "2.3.0", status: "PUBLISHED", downloadAvailable: true },
          { version: "1.4.0", status: "PUBLISHED", downloadAvailable: true },
        ],
      },
    });
  });
  const gateway = await installMockGateway(page, {
    basePath: "/platformclaw/app",
    defaultAgentId: "person_one",
    sessionKey: "agent:person_one:main",
    featureMethods: [...PLATFORMCLAW_WEB_GATEWAY_METHODS],
  });
  return { ...controls, controls, gateway };
}
