import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PLATFORMCLAW_WEB_GATEWAY_METHODS } from "../../../packages/platformclaw-control-plane/src/browser-gateway-policy.ts";
import { PLATFORMCLAW_WEB_DESCRIPTOR } from "../platformclaw/web-contract.ts";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const describeE2e =
  canRunPlaywrightChromium(executablePath) ||
  process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM !== "1"
    ? describe
    : describe.skip;
const capture = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "organization-settings");
let browser: Browser;
let server: ControlUiE2eServer;
const contexts = new Set<BrowserContext>();
const viewports = [
  { name: "mobile", viewport: { width: 390, height: 844 } },
  { name: "PC", viewport: { width: 1440, height: 900 } },
];

describeE2e("PlatformClaw Organization settings", () => {
  beforeAll(async () => {
    if (capture) {
      await mkdir(proofDir, { recursive: true });
    }
    browser = await chromium.launch({ executablePath });
    server = await startControlUiE2eServer();
  });
  afterEach(async () => {
    await Promise.all([...contexts].map((context) => context.close()));
    contexts.clear();
  });
  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it.each(viewports)(
    "renders opt-in tabs without overflow on $name",
    async ({ name, viewport }) => {
      let memberRole: "member" | "leader" = "member";
      let reviewPending = true;
      let contextReads = 0;
      let failRoleChange = name === "PC";
      const context = await browser.newContext({
        locale: "en-US",
        serviceWorkers: "block",
        viewport,
        ...(capture ? { recordVideo: { dir: proofDir, size: viewport } } : {}),
      });
      contexts.add(context);
      const page = await context.newPage();
      const response = await page.request.get(server.baseUrl);
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
              globalRole: "admin",
            },
            agent: { agentId: "person_one", state: "active" },
            session: {
              idleExpiresAt: Date.now() + 60_000,
              absoluteExpiresAt: Date.now() + 120_000,
            },
          },
          status: 200,
        }),
      );
      await page.route("**/platformclaw/api/organization/context", (route) => {
        contextReads += 1;
        return route.fulfill({
          json: {
            actor: { id: "user-1", displayName: "Person One", isAdministrator: true },
            directMemberships: [{ scopeId: "group-1", role: "member" }],
            directMembershipsHasMore: false,
            directScopeLineages: [
              {
                scopeId: "group-1",
                lineage: [
                  { id: "team-1", kind: "team", name: "Platform", status: "active" },
                  {
                    id: "group-1",
                    kind: "group",
                    name: "Runtime",
                    parentScopeId: "team-1",
                    status: "active",
                  },
                ],
              },
            ],
            effectiveScopes: [
              {
                scope: {
                  id: "group-1",
                  kind: "group",
                  name: "Runtime",
                  parentScopeId: "team-1",
                  status: "active",
                },
                source: "direct",
                directRole: "member",
              },
            ],
            effectiveScopesHasMore: false,
            primaryScope: {
              id: "group-1",
              kind: "group",
              name: "Runtime",
              parentScopeId: "team-1",
              status: "active",
            },
            primaryScopeLineage: [
              { id: "team-1", kind: "team", name: "Platform", status: "active" },
              {
                id: "group-1",
                kind: "group",
                name: "Runtime",
                parentScopeId: "team-1",
                status: "active",
              },
            ],
            isUnaffiliated: false,
            hasPendingJoinRequest: false,
            canReviewJoinRequests: true,
            canManageOrganization: true,
            canViewOrganizationAudit: true,
            joinPromptEligible: false,
          },
          status: 200,
        });
      });
      await page.route("**/platformclaw/api/organization/scopes?**", (route) =>
        route.fulfill({
          json: {
            items: [
              {
                id: "group-1",
                kind: "group",
                name: "Runtime",
                parentScopeId: "team-1",
                status: "active",
                revision: 10,
                lineage: [
                  { id: "team-1", kind: "team", name: "Platform", status: "active" },
                  {
                    id: "group-1",
                    kind: "group",
                    name: "Runtime",
                    parentScopeId: "team-1",
                    status: "active",
                  },
                ],
                capabilities: {
                  canManageMembers: true,
                  canManageStructure: true,
                  canManageLeaders: true,
                },
                requestEligible: false,
                requestState: "member",
              },
            ],
            hasMore: false,
          },
          status: 200,
        }),
      );
      await page.route("**/platformclaw/api/organization/management/scopes/group-1?**", (route) =>
        route.fulfill({
          json: {
            scope: {
              id: "group-1",
              kind: "group",
              name: "Runtime",
              parentScopeId: "team-1",
              status: "active",
              revision: 10,
            },
            members: [
              {
                user: {
                  id: "user-2",
                  accountId: "member.one",
                  displayName: "Member One",
                  status: "active",
                },
                role: memberRole,
              },
            ],
          },
          status: 200,
        }),
      );
      await page.route("**/platformclaw/api/organization/memberships", async (route) => {
        const body = route.request().postDataJSON() as {
          role: "member" | "leader";
          expectedRole: "member" | "leader" | null;
        };
        expect(body.expectedRole).toBe("member");
        if (failRoleChange) {
          failRoleChange = false;
          await route.fulfill({
            json: { error: "membership changed", code: "organization_membership_changed" },
            status: 409,
          });
          return;
        }
        memberRole = body.role;
        await route.fulfill({ json: {}, status: 200 });
      });
      await page.route("**/platformclaw/api/organization/requests/own?**", (route) =>
        route.fulfill({ json: { items: [] }, status: 200 }),
      );
      await page.route("**/platformclaw/api/organization/audit?**", (route) => {
        const search = new URL(route.request().url()).searchParams;
        const filtered = search.get("category") === "membership";
        const more = search.get("cursor") === "audit-page-two";
        return route.fulfill({
          json: {
            items: [
              {
                key: more ? "audit-two" : "audit-one",
                action: filtered ? "scope.membership.set" : "scope.renamed",
                category: filtered ? "membership" : "scope",
                occurredAt: 1_000,
                outcome: more ? "denied" : "succeeded",
                reason: "Approved organization update",
                actor: { accountId: "person.one", displayName: "Person One", status: "active" },
                subject: filtered
                  ? { accountId: "member.one", displayName: "Member One", status: "active" }
                  : undefined,
                target: {
                  type: "scope",
                  scope: { kind: "group", name: "Runtime", status: "active" },
                  lineage: [
                    { kind: "team", name: "Platform", status: "active" },
                    { kind: "group", name: "Runtime", status: "active" },
                  ],
                },
                change: filtered
                  ? { priorRole: "member", resultRole: "leader" }
                  : { beforeName: "Core", resultName: "Runtime" },
              },
            ],
            nextCursor: filtered || more ? undefined : "audit-page-two",
          },
          status: 200,
        });
      });
      await page.route("**/platformclaw/api/organization/requests/reviewable?**", (route) =>
        route.fulfill({
          json: {
            items: reviewPending
              ? [
                  {
                    request: {
                      id: "request-1",
                      scopeId: "group-1",
                      reason: "Join Runtime",
                      status: "pending",
                      createdAt: 12,
                    },
                    applicant: {
                      id: "user-3",
                      accountId: "applicant.one",
                      displayName: "Applicant One",
                      status: "active",
                    },
                    scope: {
                      id: "group-1",
                      kind: "group",
                      name: "Runtime",
                      parentScopeId: "team-1",
                      status: "active",
                    },
                    lineage: [
                      { id: "team-1", kind: "team", name: "Platform", status: "active" },
                      {
                        id: "group-1",
                        kind: "group",
                        name: "Runtime",
                        parentScopeId: "team-1",
                        status: "active",
                      },
                    ],
                  },
                ]
              : [],
          },
          status: 200,
        }),
      );
      await page.route(
        "**/platformclaw/api/organization/requests/request-1/decision",
        async (route) => {
          expect(route.request().postDataJSON()).toEqual({
            decision: "approved",
            reason: "scope confirmed",
          });
          reviewPending = false;
          await route.fulfill({ json: { id: "request-1", status: "approved" }, status: 200 });
        },
      );
      await installMockGateway(page, {
        basePath: "/platformclaw/app",
        defaultAgentId: "person_one",
        featureMethods: [...PLATFORMCLAW_WEB_GATEWAY_METHODS],
        sessionKey: "agent:person_one:main",
      });

      await page.goto(`${server.baseUrl}platformclaw/app/settings/organization`);
      await expect.poll(() => page.getByText("My organization").isVisible()).toBe(true);
      let releaseSearch!: () => void;
      const searchResponse = new Promise<void>((resolve) => {
        releaseSearch = resolve;
      });
      await page.route(
        "**/platformclaw/api/organization/scopes?q=Runtime&limit=100",
        async (route) => {
          await searchResponse;
          await route.fallback();
        },
      );
      const searchInput = page.locator('input[name="scopeQuery"]');
      await searchInput.fill("Runtime");
      const searchRequest = page.waitForRequest(
        (request) => new URL(request.url()).searchParams.get("q") === "Runtime",
      );
      await searchInput.press("Enter");
      await searchRequest;
      try {
        await expect.poll(() => searchInput.count()).toBe(1);
        expect(await searchInput.inputValue()).toBe("Runtime");
        expect(await searchInput.evaluate((input) => document.activeElement === input)).toBe(true);
        if (capture) {
          await page.screenshot({
            fullPage: true,
            path: path.join(proofDir, `${name}-overview-search-pending.png`),
          });
        }
      } finally {
        releaseSearch();
      }
      await expect
        .poll(() => page.getByText("Loading organization…", { exact: true }).count())
        .toBe(0);
      expect(await searchInput.inputValue()).toBe("Runtime");
      await page.getByRole("tab", { name: "Management" }).click();
      await expect.poll(() => page.getByText("Organization management").isVisible()).toBe(true);
      await expect.poll(() => page.getByText("Member One").isVisible()).toBe(true);
      await expect
        .poll(() => page.locator('form[aria-label="Create Team"]').isVisible())
        .toBe(true);
      if (name === "PC") {
        for (const action of ["Rename", "Archive", "Remove"]) {
          await page.getByRole("button", { name: action, exact: true }).click();
          const modal = page
            .locator("openclaw-modal-dialog")
            .filter({ has: page.locator(".exec-approval-card") });
          await modal.locator(".exec-approval-card").waitFor();
          await modal.getByRole("button", { name: "Cancel", exact: true }).click();
          await modal.waitFor({ state: "detached" });
        }
      }
      const role = page.getByRole("combobox", { name: "Membership role" });
      await role.selectOption("leader");
      await expect.poll(() => page.getByText("Confirm role change").isVisible()).toBe(true);
      if (name === "PC") {
        const reason = page.getByRole("textbox", { name: "Reason" });
        await reason.fill("   ");
        await page.getByRole("button", { name: "Confirm", exact: true }).click();
        expect(
          await reason.evaluate((input) => (input as HTMLTextAreaElement).validity.valueMissing),
        ).toBe(true);
        expect(await reason.evaluate((input) => document.activeElement === input)).toBe(true);
      }
      await page.getByRole("textbox", { name: "Reason" }).fill("promote team lead");
      await page.getByRole("button", { name: "Confirm" }).click();
      if (name === "PC") {
        const error = page.locator(".organization-action-error");
        await expect.poll(() => error.isVisible()).toBe(true);
        await expect
          .poll(() => error.evaluate((element) => document.activeElement === element))
          .toBe(true);
        expect(await page.getByRole("textbox", { name: "Reason" }).inputValue()).toBe(
          "promote team lead",
        );
        await page.getByRole("button", { name: "Cancel", exact: true }).click();
        await expect.poll(() => page.locator(".exec-approval-card").count()).toBe(0);
        expect(await role.inputValue()).toBe("member");
        await role.selectOption("leader");
        await page.getByRole("textbox", { name: "Reason" }).fill("promote team lead");
        await page.getByRole("button", { name: "Confirm" }).click();
      }
      await expect.poll(() => page.getByText("Organization updated.").isVisible()).toBe(true);
      await expect.poll(() => role.inputValue()).toBe("leader");
      expect(contextReads).toBeGreaterThan(1);
      await page.getByRole("tab", { name: "Requests" }).click();
      await expect.poll(() => page.getByText("Join an organization").isVisible()).toBe(true);
      await page.getByRole("tab", { name: "Needs review" }).click();
      await expect.poll(() => page.getByText("Applicant One").isVisible()).toBe(true);
      await page.getByRole("button", { name: "Approve" }).click();
      await page.getByRole("textbox", { name: "Reason" }).fill("scope confirmed");
      await page.getByRole("button", { name: "Confirm" }).click();
      await expect
        .poll(() => page.getByText("No request currently needs your review.").isVisible())
        .toBe(true);
      await page.getByRole("tab", { name: "Audit" }).click();
      await expect.poll(() => page.getByText("Scope renamed").isVisible()).toBe(true);
      await page.locator(".organization-audit-list summary").first().click();
      await expect.poll(() => page.getByText("Core → Runtime").isVisible()).toBe(true);
      await page.getByRole("button", { name: "Load more events" }).click();
      await expect.poll(() => page.locator(".organization-audit-list > li").count()).toBe(2);
      await expect
        .poll(() =>
          page.locator(".organization-audit-list summary").nth(1).getByText("Denied").isVisible(),
        )
        .toBe(true);
      await page.getByLabel("Category").selectOption("membership");
      await expect.poll(() => page.getByText("Membership updated").isVisible()).toBe(true);
      await page.locator(".organization-audit-list summary").click();
      await expect.poll(() => page.getByText("Member One").isVisible()).toBe(true);
      expect(await page.locator("body").evaluate((body) => body.scrollWidth <= innerWidth)).toBe(
        true,
      );
      if (capture) {
        await page.screenshot({
          fullPage: true,
          path: path.join(proofDir, `${name}-management-narrow.png`),
        });
      }
      await page.setViewportSize({ width: 1280, height: 900 });
      expect(await page.locator("body").evaluate((body) => body.scrollWidth <= innerWidth)).toBe(
        true,
      );
      if (capture) {
        await page.screenshot({
          fullPage: true,
          path: path.join(proofDir, `${name}-management-desktop.png`),
        });
      }
    },
  );

  it.each(viewports)(
    "lets an unaffiliated user dismiss the prompt, request membership, and cancel in Korean on $name",
    async ({ name, viewport }) => {
      let requestStatus: "none" | "pending" | "cancelled" = "none";
      const context = await browser.newContext({
        locale: "ko-KR",
        serviceWorkers: "block",
        viewport,
      });
      contexts.add(context);
      const page = await context.newPage();
      const response = await page.request.get(server.baseUrl);
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
              accountId: "person.two",
              displayName: "Person Two",
              department: "",
              globalRole: "member",
            },
            agent: { agentId: "person_two", state: "active" },
            session: {
              idleExpiresAt: Date.now() + 60_000,
              absoluteExpiresAt: Date.now() + 120_000,
            },
          },
          status: 200,
        }),
      );
      await page.route("**/platformclaw/api/organization/context", (route) =>
        route.fulfill({
          json: {
            actor: { id: "user-2", displayName: "Person Two", isAdministrator: false },
            directMemberships: [],
            directMembershipsHasMore: false,
            directScopeLineages: [],
            effectiveScopes: [],
            effectiveScopesHasMore: false,
            isUnaffiliated: true,
            hasPendingJoinRequest: requestStatus === "pending",
            canReviewJoinRequests: false,
            canManageOrganization: false,
            canViewOrganizationAudit: false,
            joinPromptEligible: requestStatus === "none",
          },
          status: 200,
        }),
      );
      await page.route("**/platformclaw/api/organization/scopes?**", (route) =>
        route.fulfill({
          json: {
            items: [
              {
                id: "team-1",
                kind: "team",
                name: "Platform",
                status: "active",
                revision: 10,
                lineage: [{ id: "team-1", kind: "team", name: "Platform", status: "active" }],
                capabilities: {
                  canManageMembers: false,
                  canManageStructure: false,
                  canManageLeaders: false,
                },
                requestEligible: requestStatus !== "pending",
                requestState: requestStatus === "pending" ? "pending" : "eligible",
              },
            ],
            hasMore: false,
          },
          status: 200,
        }),
      );
      await page.route("**/platformclaw/api/organization/requests/own?**", (route) =>
        route.fulfill({
          json: {
            items:
              requestStatus === "none"
                ? []
                : [
                    {
                      request: {
                        id: "request-join",
                        scopeId: "team-1",
                        reason: "Platform 업무 참여",
                        status: requestStatus,
                        createdAt: 12,
                      },
                      scope: {
                        id: "team-1",
                        kind: "team",
                        name: "Platform",
                        status: "active",
                      },
                      lineage: [{ id: "team-1", kind: "team", name: "Platform", status: "active" }],
                    },
                  ],
          },
          status: 200,
        }),
      );
      await page.route("**/platformclaw/api/organization/requests/reviewable?**", (route) =>
        route.fulfill({ json: { items: [] }, status: 200 }),
      );
      await page.route("**/platformclaw/api/organization/requests", async (route) => {
        expect(route.request().postDataJSON()).toEqual({
          scopeId: "team-1",
          reason: "Platform 업무 참여",
        });
        requestStatus = "pending";
        await route.fulfill({ json: { id: "request-join", status: "pending" }, status: 200 });
      });
      await page.route(
        "**/platformclaw/api/organization/requests/request-join/cancel",
        async (route) => {
          expect(route.request().postDataJSON()).toEqual({ reason: "요청 철회" });
          requestStatus = "cancelled";
          await route.fulfill({ json: { id: "request-join", status: "cancelled" }, status: 200 });
        },
      );
      await installMockGateway(page, {
        basePath: "/platformclaw/app",
        defaultAgentId: "person_two",
        featureMethods: [...PLATFORMCLAW_WEB_GATEWAY_METHODS],
        sessionKey: "agent:person_two:main",
      });

      await page.goto(`${server.baseUrl}platformclaw/app/chat`);
      const dismissGuide = page.getByRole("button", { name: "다시 보지 않기", exact: true });
      if (name === "PC") {
        await dismissGuide.waitFor();
        await dismissGuide.click();
      } else {
        expect(await dismissGuide.count()).toBe(0);
      }
      await expect.poll(() => page.getByText("조직에 가입하세요").isVisible()).toBe(true);
      await page.getByRole("button", { name: "나중에" }).click();
      await expect.poll(() => page.getByText("조직에 가입하세요").count()).toBe(0);
      await page.evaluate(() => sessionStorage.clear());
      await page.reload();
      if (name === "PC" && (await dismissGuide.isVisible())) {
        await dismissGuide.click();
      }
      await expect.poll(() => page.getByText("조직에 가입하세요").isVisible()).toBe(true);
      await page.getByRole("link", { name: "조직 찾기" }).click();
      await expect.poll(() => new URL(page.url()).searchParams.get("tab")).toBe("requests");
      await expect.poll(() => page.getByText("조직 가입").isVisible()).toBe(true);
      expect(await page.getByRole("tab", { name: "감사" }).count()).toBe(0);
      await page.locator(".organization-request-list .primary").click();
      if (name === "PC") {
        const reason = page.locator(".organization-action-form textarea");
        await reason.fill("   ");
        await page.locator('.organization-action-form button[type="submit"]').click();
        expect(
          await reason.evaluate((input) => (input as HTMLTextAreaElement).validity.valueMissing),
        ).toBe(true);
        expect(await reason.evaluate((input) => document.activeElement === input)).toBe(true);
      }
      await page.locator(".organization-action-form textarea").fill("Platform 업무 참여");
      await page.locator('.organization-action-form button[type="submit"]').click();
      await expect.poll(() => page.getByText("Platform 업무 참여").isVisible()).toBe(true);
      await page.getByRole("button", { name: "요청 취소" }).click();
      await page.locator(".organization-action-form textarea").fill("요청 철회");
      await page.locator('.organization-action-form button[type="submit"]').click();
      await expect.poll(() => page.getByText("취소됨").isVisible()).toBe(true);
      expect(await page.locator("body").evaluate((body) => body.scrollWidth <= innerWidth)).toBe(
        true,
      );
      if (capture) {
        await page.screenshot({
          fullPage: true,
          path: path.join(proofDir, `${name}-join-narrow-ko.png`),
        });
      }
      await page.setViewportSize({ width: 1280, height: 900 });
      expect(await page.locator("body").evaluate((body) => body.scrollWidth <= innerWidth)).toBe(
        true,
      );
      if (capture) {
        await page.screenshot({
          fullPage: true,
          path: path.join(proofDir, `${name}-join-desktop-ko.png`),
        });
      }
    },
  );
});
