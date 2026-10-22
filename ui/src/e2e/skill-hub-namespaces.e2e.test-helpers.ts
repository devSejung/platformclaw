import type { Page } from "playwright";
import { expect } from "vitest";
import type { PlatformClawSkillHubConfig } from "../platformclaw/skill-hub.ts";

export async function verifyMemberNamespacePublishing(
  page: Page,
  baseUrl: string,
  korean: boolean,
) {
  const labels = korean
    ? {
        create: "네임스페이스 만들기",
        action: "작업 공간 스킬 게시",
        submit: "검사 후 스킬 게시",
        conflict: "다른 이름을 입력하세요",
        forbidden: "창을 다시 열어",
        retry: "같은 이름과 공유 범위로 다시 시도",
      }
    : {
        create: "Create namespace",
        action: "Publish workspace skill",
        submit: "Scan and publish skill",
        conflict: "Choose another name",
        forbidden: "Reopen this dialog",
        retry: "Retry with the same namespace and scope",
      };
  const config: PlatformClawSkillHubConfig = {
    namespaces: ["engineering", "global"],
    defaultNamespace: "global",
    namespaceOptions: [
      { namespace: "engineering", scopeKind: "team", scopeName: "Engineering" },
      { namespace: "global", scopeKind: "global" },
    ],
    maxPackageBytes: 1024,
    admin: false,
    activeTarget: "assigned_vm",
    installTargets: [
      { target: "platform_server", available: true, status: "ready" },
      { target: "assigned_vm", available: true, status: "ready" },
    ],
    capabilities: {
      scanner: true,
      forcePublish: false,
      ownerTransfer: false,
      accessControl: false,
      notifications: true,
      zipUpload: true,
      namespaceCreate: true,
    },
  };
  const scopes = [
    { scopeKind: "team", scopeId: "team-one", scopeName: "Engineering" },
    { scopeKind: "global" },
    { scopeKind: "group", scopeId: "group-one", scopeName: "Platform" },
    { scopeKind: "part", scopeId: "part-one", scopeName: "Runtime" },
  ];
  const created = new Set<string>();
  const creationRequests: Array<Record<string, unknown>> = [];
  const published: Array<Record<string, unknown>> = [];
  let interrupted = false;
  await page.route("**/platformclaw/api/skill-hub/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/config")) {
      return route.fulfill({ json: config });
    }
    if (url.pathname.endsWith("/namespaces")) {
      if (route.request().method() === "GET") {
        return route.fulfill({
          json: {
            scopes,
            creations: interrupted
              ? [
                  {
                    namespace: "interrupted-tools",
                    scopeKind: "global",
                    state: "uncertain",
                    updatedAt: 1,
                  },
                ]
              : [],
          },
        });
      }
      const body = route.request().postDataJSON() as {
        namespace: string;
        scopeKind: "global" | "team";
        scopeId?: string;
      };
      creationRequests.push(body);
      if (created.has(body.namespace)) {
        return route.fulfill({
          status: 409,
          json: { error: "Namespace exists", details: { code: "skill-hub-namespace-conflict" } },
        });
      }
      if (body.namespace === "forbidden-tools") {
        return route.fulfill({ status: 403, json: { error: "Membership changed" } });
      }
      if (body.namespace === "interrupted-tools" && !interrupted) {
        interrupted = true;
        return route.fulfill({
          status: 503,
          json: { error: "Creation interrupted", details: { code: "skill-hub-namespace-retry" } },
        });
      }
      interrupted = false;
      created.add(body.namespace);
      config.namespaces.push(body.namespace);
      config.namespaceOptions.push({
        namespace: body.namespace,
        scopeKind: body.scopeKind,
        ...(body.scopeKind === "team" ? { scopeName: "Engineering" } : {}),
      });
      return route.fulfill({
        json: {
          ...body,
          accessState: "active",
          visibilityCeiling: "NAMESPACE_ONLY",
          createdAt: 1,
          updatedAt: 1,
        },
      });
    }
    if (url.pathname.endsWith("/workspace-skills")) {
      return route.fulfill({
        json: {
          source: url.searchParams.get("source"),
          items: [{ skillKey: "vm-release", version: "2.3.0" }],
        },
      });
    }
    if (url.pathname.endsWith("/publish")) {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      published.push(body);
      return route.fulfill({
        json: { namespace: body.namespace, slug: body.skill, version: body.version },
      });
    }
    return route.fulfill({ json: { items: [], total: 0 } });
  });

  await page.goto(`${baseUrl}platformclaw/app/skills/hub`);
  const createAction = page.getByRole("button", { name: labels.create, exact: true });
  await expect.poll(() => createAction.isVisible()).toBe(true);
  expect(
    await page
      .locator(".skill-hub-header-actions")
      .getByText(korean ? "스킬 허브 관리" : "Skill Hub admin", { exact: true })
      .count(),
  ).toBe(0);
  await createAction.click();
  const dialog = page.locator(".skill-hub-namespace");
  const name = dialog.locator('input[name="namespace"]');
  const scope = dialog.locator('select[name="scope"]');
  const submit = dialog.getByRole("button", { name: labels.create, exact: true });
  await expect.poll(() => scope.inputValue()).toBe("1");
  expect(await scope.locator("option").count()).toBe(5);
  expect(await scope.textContent()).not.toContain("Secret Part");
  await name.fill("release-tools");
  await submit.click();
  await expect.poll(() => dialog.count()).toBe(0);
  await expect
    .poll(() => page.locator(".callout.success").textContent())
    .toContain("release-tools");

  const publishAction = page.getByRole("button", { name: labels.action, exact: true });
  await publishAction.click();
  const publishDialog = page.locator(".skill-hub-workspace-publish");
  const destination = publishDialog.locator("select").nth(2);
  await expect.poll(() => destination.inputValue()).toBe("global");
  await destination.selectOption("release-tools");
  await publishDialog.getByRole("button", { name: labels.submit, exact: true }).click();
  await expect.poll(() => published.length).toBe(1);
  expect(published[0]).toMatchObject({
    namespace: "release-tools",
    source: "assigned_vm",
    skill: "vm-release",
  });
  await expect.poll(() => publishDialog.count()).toBe(0);

  await createAction.click();
  await expect.poll(() => scope.inputValue()).toBe("1");
  await name.fill("release-tools");
  await submit.click();
  await expect
    .poll(() => dialog.locator('[role="alert"]').textContent())
    .toContain(labels.conflict);
  expect(await name.inputValue()).toBe("release-tools");
  await name.fill("forbidden-tools");
  await scope.selectOption("0");
  await submit.click();
  await expect
    .poll(() => dialog.locator('[role="alert"]').textContent())
    .toContain(labels.forbidden);
  expect(await scope.inputValue()).toBe("0");
  await name.fill("team-tools");
  await submit.click();
  await expect.poll(() => dialog.count()).toBe(0);
  expect(creationRequests.at(-1)).toEqual({
    namespace: "team-tools",
    scopeKind: "team",
    scopeId: "team-one",
  });

  await createAction.click();
  await expect.poll(() => scope.inputValue()).toBe("1");
  await name.fill("interrupted-tools");
  await submit.click();
  await expect.poll(() => dialog.locator('[role="alert"]').textContent()).toContain(labels.retry);
  expect(await name.inputValue()).toBe("interrupted-tools");
  await submit.click();
  await expect.poll(() => dialog.count()).toBe(0);
  expect(creationRequests.slice(-2)).toEqual([
    { namespace: "interrupted-tools", scopeKind: "global" },
    { namespace: "interrupted-tools", scopeKind: "global" },
  ]);
  await publishAction.click();
  await expect.poll(() => destination.inputValue()).toBe("global");
  await destination.selectOption("team-tools");
  await publishDialog.getByRole("button", { name: labels.submit, exact: true }).click();
  await expect.poll(() => published.length).toBe(2);
  expect(published[1]).toMatchObject({ namespace: "team-tools", source: "assigned_vm" });
}
