import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PLATFORMCLAW_WEB_GATEWAY_METHODS } from "../../../packages/platformclaw-control-plane/src/browser-gateway-policy.ts";
import type { OrganizationScopeResult } from "../platformclaw/organization-api.ts";
import type { PlatformClawSessionIdentity } from "../platformclaw/web-contract.ts";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import { installPlatformClawDocument } from "./platformclaw-document.test-support.ts";

const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const suite =
  canRunPlaywrightChromium(executablePath) ||
  process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM !== "1"
    ? describe
    : describe.skip;
const capture = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.join(process.cwd(), ".artifacts/control-ui-e2e/directory-organization");
const basePath = "/platformclaw/app";
let browser: Browser;
let server: ControlUiE2eServer;

async function screenshot(page: Page, name: string): Promise<void> {
  if (capture) {
    await mkdir(proofDir, { recursive: true });
    await page.screenshot({
      animations: "disabled",
      fullPage: true,
      path: path.join(proofDir, name),
    });
  }
}

suite("PlatformClaw directory organization browser experience", () => {
  beforeAll(async () => {
    browser = await chromium.launch({ executablePath });
    server = await startControlUiE2eServer(undefined, { source: true });
  });
  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it.each([
    { name: "desktop", viewport: { width: 1440, height: 960 } },
    { name: "mobile", viewport: { width: 390, height: 844 } },
  ])(
    "distinguishes same-name scopes and retains manual access on $name",
    async ({ name, viewport }) => {
      const context = await browser.newContext({
        locale: "en-US",
        serviceWorkers: "block",
        viewport,
      });
      try {
        const page = await context.newPage();
        await page.addInitScript(() => localStorage.setItem("openclaw.i18n.locale", "en"));
        await installPlatformClawDocument(page, server.baseUrl);
        const team = {
          id: "team-directory",
          kind: "team" as const,
          name: "Platform",
          status: "active" as const,
          managedBy: "ldap-login" as const,
          externalKey: "team:Platform",
        };
        const group = {
          ...team,
          id: "group-directory",
          kind: "group" as const,
          name: "Runtime",
          parentScopeId: team.id,
          externalKey: "group:runtime",
        };
        const parts: OrganizationScopeResult[] = ["first", "second"].map((key) => {
          const part = Object.assign({}, group, {
            id: `part-${key}`,
            kind: "part" as const,
            name: "SDK",
            parentScopeId: group.id,
            externalKey: `aicm-part:${key}`,
          });
          return Object.assign({}, part, {
            revision: 10,
            lineage: [team, group, part],
            capabilities: {
              canManageMembers: true,
              canManageStructure: false,
              canManageLeaders: true,
            },
            requestState: "member" as const,
            requestEligible: false,
          });
        });
        let retained = false;
        const managementReads: string[] = [];
        await page.route("**/platformclaw/api/**", async (route) => {
          const request = route.request();
          const pathname = new URL(request.url()).pathname;
          if (pathname.endsWith("/auth/session")) {
            await route.fulfill({
              json: {
                authenticated: true,
                user: {
                  accountId: "directory.admin",
                  displayName: "Directory Admin",
                  department: "Synthetic Lab",
                  globalRole: "admin",
                } satisfies Omit<PlatformClawSessionIdentity, "agentId">,
                agent: { agentId: "directory_admin", state: "active" },
                session: {
                  idleExpiresAt: Date.now() + 60_000,
                  absoluteExpiresAt: Date.now() + 120_000,
                },
              },
            });
          } else if (pathname.endsWith("/organization/context")) {
            await route.fulfill({
              json: {
                actor: {
                  id: "user-directory",
                  displayName: "Directory Admin",
                  isAdministrator: true,
                },
                directMemberships: parts.map((scope) => ({
                  scopeId: scope.id,
                  role: "member",
                  managedBy: "ldap-login",
                })),
                directMembershipsHasMore: false,
                directScopeLineages: parts.map((scope) => ({
                  scopeId: scope.id,
                  lineage: scope.lineage,
                })),
                effectiveScopes: parts.map((scope) => ({
                  scope,
                  source: "direct",
                  directRole: "member",
                })),
                effectiveScopesHasMore: false,
                primaryScope: parts[0],
                primaryScopeLineage: parts[0]!.lineage,
                isUnaffiliated: false,
                hasPendingJoinRequest: false,
                joinPromptEligible: false,
                canReviewJoinRequests: true,
                canManageOrganization: true,
                canViewOrganizationAudit: true,
              },
            });
          } else if (pathname.endsWith("/organization/scopes")) {
            await route.fulfill({ json: { items: parts, hasMore: false } });
          } else if (pathname.includes("/organization/management/scopes/")) {
            const scope = parts.find((entry) => pathname.endsWith(`/${entry.id}`));
            if (!scope) {
              throw new Error(`Unexpected management route: ${pathname}`);
            }
            managementReads.push(scope.id);
            await route.fulfill({
              json: {
                scope,
                members: [
                  {
                    user: {
                      id: "member-directory",
                      accountId: "member.directory",
                      displayName: "Directory Member",
                      status: "active",
                    },
                    role: "member",
                    managedBy: "ldap-login",
                    ...(retained && scope.id === "part-second" ? { manualRole: "member" } : {}),
                  },
                ],
              },
            });
          } else if (pathname.endsWith("/organization/memberships")) {
            expect(request.postDataJSON()).toEqual({
              scopeId: "part-second",
              userId: "member-directory",
              role: "member",
              expectedRole: "member",
              reason: "Retain cross-team project access",
            });
            retained = true;
            await route.fulfill({ json: {} });
          } else if (pathname.includes("announcements")) {
            await route.fulfill({
              json: { revision: 0, serverNow: Date.now(), announcement: null, current: null },
            });
          } else {
            await route.fulfill({ json: {} });
          }
        });
        await installMockGateway(page, {
          basePath,
          defaultAgentId: "directory_admin",
          sessionKey: "agent:directory_admin:main",
          featureMethods: [...PLATFORMCLAW_WEB_GATEWAY_METHODS],
        });
        await page.goto(`${server.baseUrl}platformclaw/app/settings/organization`);
        await expect
          .poll(() => page.getByText("My organization", { exact: true }).isVisible())
          .toBe(true);
        const primary = page.getByRole("combobox", { name: "Primary scope", exact: true });
        expect(await primary.locator("option").allTextContents()).toEqual([
          "No primary scope",
          expect.stringContaining("Platform / Runtime / SDK (aicm-part:first)"),
          expect.stringContaining("Platform / Runtime / SDK (aicm-part:second)"),
        ]);
        await screenshot(page, `${name}-same-name-overview.png`);
        await page.getByRole("tab", { name: "Management", exact: true }).click();
        const picker = page.getByRole("combobox", { name: "Managed scope", exact: true });
        expect(await picker.locator("option").allTextContents()).toEqual([
          expect.stringContaining("Platform / Runtime / SDK (aicm-part:first)"),
          expect.stringContaining("Platform / Runtime / SDK (aicm-part:second)"),
        ]);
        await picker.selectOption("part-second");
        await expect.poll(() => managementReads.at(-1)).toBe("part-second");
        await expect
          .poll(() =>
            page.getByRole("button", { name: "Keep manual membership", exact: true }).isVisible(),
          )
          .toBe(true);
        expect(await page.getByRole("button", { name: "Rename", exact: true }).count()).toBe(0);
        expect(await page.getByRole("button", { name: "Archive", exact: true }).count()).toBe(0);
        await screenshot(page, `${name}-automatic-management.png`);
        await page.getByRole("button", { name: "Keep manual membership", exact: true }).click();
        await expect
          .poll(() => page.getByText("Confirm manual membership", { exact: true }).isVisible())
          .toBe(true);
        await page
          .getByRole("textbox", { name: "Reason", exact: true })
          .fill("Retain cross-team project access");
        await page.getByRole("button", { name: "Confirm", exact: true }).click();
        await expect
          .poll(() => page.getByText("Manual membership retained", { exact: true }).isVisible())
          .toBe(true);
        expect(retained).toBe(true);
        expect(await picker.inputValue()).toBe("part-second");
        expect(
          await page.getByRole("button", { name: "Keep manual membership", exact: true }).count(),
        ).toBe(0);
        expect(await page.locator("body").evaluate((body) => body.scrollWidth <= innerWidth)).toBe(
          true,
        );
        await screenshot(page, `${name}-manual-membership-retained.png`);
      } finally {
        await context.close();
      }
    },
  );
});
