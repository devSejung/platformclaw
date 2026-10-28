import { mkdir } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import type { SkillStatusReport } from "../api/types.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installSkillHubFixture } from "./skill-hub-installation.e2e.test-helpers.ts";

const proofDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "skill-hub-targets");
const locales = ["en-US", "ko-KR"] as const;
const copy = {
  "en-US": {
    publish: "Publish workspace skill",
    reload: "Reload workspace skills",
    changed: "The skill or workspace changed.",
    upload: "Upload ZIP",
    close: "Close",
  },
  "ko-KR": {
    publish: "작업 공간 스킬 게시",
    reload: "스킬 목록 다시 불러오기",
    changed: "스킬이나 작업 공간이 변경되었습니다.",
    upload: "ZIP 업로드",
    close: "닫기",
  },
};
const suite = createControlUiE2eSuite({
  name: "Skill Hub inspected workspace identity",
  unavailableMessage: (executablePath) => `Playwright Chromium unavailable at ${executablePath}`,
  trackBrowserContexts: true,
});

async function newPage(locale: (typeof locales)[number], width: number) {
  await mkdir(proofDir, { recursive: true });
  const context = await suite.newBrowserContext({
    locale,
    viewport: { width, height: 1000 },
    serviceWorkers: "block",
  });
  const page = await context.newPage();
  const fixture = await installSkillHubFixture(page, suite.server.baseUrl);
  fixture.config.scopes = [{ id: "another-part", kind: "part", name: "Another Part" }];
  const originalLabel = `review-vm-one-${"x".repeat(180)}<b>literal</b>`;
  const active = { id: "vm-one", revision: 1, label: originalLabel };
  await page.route("**/platformclaw/api/skill-hub/workspace-skills?**", (route) => {
    const source = new URL(route.request().url()).searchParams.get("source")!;
    return route.fulfill({
      json: {
        source,
        targetId: source === "assigned_vm" ? active.id : "platform-server",
        targetRevision: active.revision,
        ...(source === "assigned_vm" ? { targetLabel: active.label } : {}),
        items:
          source === "assigned_vm"
            ? fixture.inventories.assigned_vm
            : fixture.inventories.platform_server,
      },
    });
  });
  return { page, active, originalLabel, ...fixture };
}

async function capture(page: Page, panel: Locator, name: string, action?: Locator) {
  if (action) {
    await action.scrollIntoViewIfNeeded();
    const bounds = await action.boundingBox();
    expect(bounds?.y).toBeGreaterThanOrEqual(0);
    expect(bounds && bounds.y + bounds.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  }
  const metrics = await panel.evaluate((element) => ({
    width: innerWidth,
    left: element.getBoundingClientRect().left,
    right: element.getBoundingClientRect().right,
    scroll: element.scrollWidth,
    client: element.clientWidth,
    documentWidth: document.documentElement.scrollWidth,
  }));
  expect(metrics.left).toBeGreaterThanOrEqual(0);
  expect(metrics.right).toBeLessThanOrEqual(metrics.width + 1);
  expect(metrics.scroll).toBeLessThanOrEqual(metrics.client + 1);
  expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.width + 1);
  await page.screenshot({ path: path.join(proofDir, `${name}.png`), animations: "disabled" });
}

suite.define(() => {
  it.each(locales)(
    "keeps a reopened skill draft when an earlier opening responds last in %s",
    async (locale) => {
      const { page, gateway } = await newPage(locale, 1440);
      const report: SkillStatusReport = {
        workspaceDir: "/synthetic/workspace",
        managedSkillsDir: "/synthetic/skills",
        executionTarget: "platform_server",
        skills: ["Alpha", "Beta"].map((name) => ({
          name,
          description: `Synthetic ${name}`,
          source: "openclaw-workspace",
          filePath: `/synthetic/${name}/SKILL.md`,
          baseDir: `/synthetic/${name}`,
          skillKey: name.toLowerCase(),
          always: false,
          disabled: false,
          blockedByAllowlist: false,
          eligible: true,
          requirements: { anyBins: [], bins: [], env: [], config: [], os: [] },
          missing: { anyBins: [], bins: [], env: [], config: [], os: [] },
          configChecks: [],
          install: [],
        })),
      };
      let releaseFirst!: () => void;
      const held = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let reads = 0;
      await page.route("**/platformclaw/api/skill-hub/workspace-skills?**", async (route) => {
        const source = new URL(route.request().url()).searchParams.get("source");
        reads += 1;
        if (reads === 1) {
          await held;
        }
        return route.fulfill({
          json: {
            source,
            targetId: source === "assigned_vm" ? "vm-beta" : "platform-server",
            targetRevision: 2,
            targetLabel: source === "assigned_vm" ? "Beta VM" : undefined,
            items: [
              { skillKey: "alpha", version: "1.0.0" },
              { skillKey: "beta", version: "2.0.0" },
            ],
          },
        });
      });
      const requests: Array<Record<string, unknown>> = [];
      await page.route("**/platformclaw/api/skill-hub/publish", (route) => {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        requests.push(body);
        return route.fulfill({
          json: { id: "entry-beta", slug: body.skill, version: body.version },
        });
      });
      await page.goto(`${suite.server.baseUrl}platformclaw/app/skills/hub`);
      await gateway.setMethodResponse("skills.status", report);
      await page.goto(`${suite.server.baseUrl}platformclaw/app/skills`);
      const skills = page.locator("openclaw-skills-page");
      const row = (name: string) => skills.locator(".settings-row").filter({ hasText: name });
      await row("Alpha").locator(".settings-row__control > button").click();
      const dialog = skills.locator(".skill-hub-workspace-publish");
      await expect.poll(() => reads).toBe(1);
      await dialog.getByRole("button", { name: copy[locale].close, exact: true }).click();
      report.executionTarget = "assigned_vm";
      report.skills.forEach((skill) => {
        skill.source = "platformclaw-vm-workspace";
      });
      await gateway.setMethodResponse("skills.status", report);
      await skills.locator(".plugins-toolbar--fields > button").click();
      await expect
        .poll(async () => (await gateway.getRequests("skills.status")).length)
        .toBeGreaterThanOrEqual(2);
      await row("Beta").locator(".settings-row__control > button").click();
      await expect.poll(() => dialog.locator('[name="skill"]').inputValue()).toBe("beta");
      await dialog.locator('[name="version"]').fill("7.0.0");
      await dialog.locator('[name="sharing"]').selectOption("SELECTED");
      await dialog.locator('[value="another-part"]').check();
      const lateResponse = page.waitForResponse((response) =>
        response.url().includes("/workspace-skills?source=platform_server"),
      );
      releaseFirst();
      await (await lateResponse).finished();
      // Observe the next rendered frame after the old response body has finished.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
          }),
      );
      expect(await dialog.locator('[name="skill"]').inputValue()).toBe("beta");
      expect(await dialog.locator('[name="source"]').inputValue()).toBe("assigned_vm");
      expect(await dialog.locator('[name="version"]').inputValue()).toBe("7.0.0");
      expect(await dialog.locator('[name="sharing"]').inputValue()).toBe("SELECTED");
      expect(await dialog.locator('[value="another-part"]').isChecked()).toBe(true);
      const presentation = await dialog.evaluate((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return {
          display: style.display,
          background: style.backgroundColor,
          padding: Number.parseFloat(style.paddingLeft),
          contentLeft:
            rect.left +
            Number.parseFloat(style.paddingLeft) +
            Number.parseFloat(style.borderLeftWidth),
          contentRight:
            rect.right -
            Number.parseFloat(style.paddingRight) -
            Number.parseFloat(style.borderRightWidth),
          fields: [...element.querySelectorAll(".field input, .field select")].map((field) => {
            const bounds = field.getBoundingClientRect();
            return { left: bounds.left, right: bounds.right };
          }),
        };
      });
      expect(presentation.display).toBe("grid");
      expect(presentation.padding).toBeGreaterThan(0);
      expect(presentation.background).not.toBe("rgba(0, 0, 0, 0)");
      for (const field of presentation.fields) {
        expect(field.left).toBeGreaterThanOrEqual(presentation.contentLeft);
        expect(field.right).toBeLessThanOrEqual(presentation.contentRight + 1);
      }
      await capture(
        page,
        dialog,
        `${locale}-reopened-beta-draft`,
        dialog.locator("button.primary"),
      );
      await dialog.locator("button.primary").click();
      await expect.poll(() => requests.length).toBe(1);
      expect(requests[0]).toMatchObject({
        skill: "beta",
        source: "assigned_vm",
        expectedTargetId: "vm-beta",
        version: "7.0.0",
        sharing: { mode: "SELECTED", userIds: [], scopeIds: ["another-part"] },
      });
    },
  );

  it.each(locales.flatMap((locale) => [320, 390].map((width) => ({ locale, width }))))(
    "contains sharing controls and their selected labels in $locale at $width pixels",
    async ({ locale, width }) => {
      const { page } = await newPage(locale, width);
      await page.goto(`${suite.server.baseUrl}platformclaw/app/skills/hub`);
      await page.getByRole("button", { name: copy[locale].upload, exact: true }).click();
      const dialog = page.locator(".skill-hub-upload");
      const sharing = dialog.locator('[name="sharing"]');
      for (const mode of ["PUBLIC", "SELECTED", "PRIVATE"]) {
        await sharing.selectOption(mode);
        await sharing.scrollIntoViewIfNeeded();
        const bounds = await sharing.evaluate((element) => {
          const select = element as HTMLSelectElement;
          const rect = select.getBoundingClientRect();
          const owner = select.closest(".skill-hub-sharing")!.getBoundingClientRect();
          const style = getComputedStyle(select);
          const canvas = document.createElement("canvas").getContext("2d")!;
          canvas.font = style.font;
          return {
            left: rect.left,
            right: rect.right,
            ownerLeft: owner.left,
            ownerRight: owner.right,
            text: canvas.measureText(select.selectedOptions[0]!.textContent!.trim()).width,
            available:
              rect.width -
              Number.parseFloat(style.paddingLeft) -
              Number.parseFloat(style.paddingRight) -
              Number.parseFloat(style.borderLeftWidth) -
              Number.parseFloat(style.borderRightWidth),
          };
        });
        expect(bounds.left).toBeGreaterThanOrEqual(bounds.ownerLeft);
        expect(bounds.right).toBeLessThanOrEqual(bounds.ownerRight + 1);
        expect(bounds.text).toBeLessThanOrEqual(bounds.available + 1);
        if (mode === "SELECTED") {
          await capture(
            page,
            dialog,
            `${locale}-sharing-contained-${width}`,
            dialog.locator("button.primary"),
          );
        }
      }
    },
  );

  it.each(locales)(
    "keeps publication pinned to the displayed VM and restores the original request after VM reactivation in %s",
    async (locale) => {
      const { page, active, originalLabel, inventories, config, executionMutations } =
        await newPage(locale, 320);
      const labels = copy[locale];
      inventories.assigned_vm = [{ skillKey: "demo", version: "3.0.0", revision: "same-files" }];
      const requests: Array<Record<string, unknown>> = [];
      const effects: string[] = [];
      await page.route("**/platformclaw/api/skill-hub/publish", (route) => {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        requests.push(body);
        if (body.expectedTargetId !== undefined && body.expectedTargetId !== active.id) {
          return route.fulfill({
            status: 409,
            json: { error: "Execution target changed", details: { code: "skill-hub-changed" } },
          });
        }
        if (active.id === "vm-one" && requests.length === 3) {
          config.pendingPublications = [
            {
              operationId: String(body.operationId),
              skillId: "pending-entry",
              actorUserId: "person.one",
              displayName: "Demo",
              version: "7.0.0",
              expectedRevision: 1,
              isMine: true,
              state: "pending",
              createdAt: 1,
              updatedAt: 1,
              fingerprint: "original",
            },
          ];
          return route.fulfill({
            status: 503,
            json: {
              error: "Receipt confirmation unavailable",
              details: { code: "skill-hub-publication-pending" },
            },
          });
        }
        effects.push(active.id);
        if (active.id === "vm-one") {
          config.pendingPublications = [];
        }
        return route.fulfill({ json: { id: active.id, slug: body.skill, version: body.version } });
      });
      await page.goto(`${suite.server.baseUrl}platformclaw/app/skills/hub`);
      await page.getByRole("button", { name: labels.publish, exact: true }).click();
      const dialog = page.locator(".skill-hub-workspace-publish");
      await expect
        .poll(() => dialog.locator(".skill-hub-target-label").textContent())
        .toBe(originalLabel);
      expect(await dialog.locator(".skill-hub-target-label b").count()).toBe(0);
      await capture(page, dialog, `${locale}-publish-long-vm-name-320`);
      await dialog.locator('[name="version"]').fill("7.0.0");
      await dialog.locator('[name="sharing"]').selectOption("SELECTED");
      await dialog.locator('[value="another-part"]').check();
      Object.assign(active, { id: "vm-two", revision: 2, label: "Review VM two" });
      await dialog.locator("button.primary").click();
      await expect
        .poll(() => dialog.locator(".skill-hub-publication-recovery button").isEnabled())
        .toBe(true);
      const originalId = requests[0]!.operationId;
      await expect.poll(() => dialog.getByRole("alert").textContent()).toContain(labels.changed);
      await expect.poll(() => dialog.locator("button.primary").isEnabled()).toBe(true);
      expect(effects).toEqual([]);
      expect(requests[0]).toMatchObject({ expectedTargetId: "vm-one" });
      expect(requests[0]).not.toHaveProperty("expectedTargetRevision");
      await dialog.getByRole("button", { name: labels.reload, exact: true }).click();
      await expect
        .poll(() => dialog.locator(".skill-hub-target-label").textContent())
        .toBe("Review VM two");
      expect(await dialog.locator('[name="version"]').inputValue()).toBe("7.0.0");
      expect(await dialog.locator('[name="skill"]').inputValue()).toBe("demo");
      expect(await dialog.locator('[name="sharing"]').inputValue()).toBe("SELECTED");
      expect(await dialog.locator('[value="another-part"]').isChecked()).toBe(true);
      await capture(
        page,
        dialog,
        `${locale}-reload-vm-two-preserved-draft-320`,
        dialog.locator("button.primary"),
      );
      await dialog.locator("button.primary").click();
      await expect.poll(() => dialog.count()).toBe(0);
      expect(requests[1]).toMatchObject({
        expectedTargetId: "vm-two",
        version: "7.0.0",
        sharing: { mode: "SELECTED", userIds: [], scopeIds: ["another-part"] },
      });
      expect(requests[1]!.operationId).not.toBe(originalId);
      Object.assign(active, { id: "vm-one", revision: 99, label: originalLabel });
      await page.getByRole("button", { name: labels.publish, exact: true }).click();
      await expect
        .poll(() => dialog.locator(".skill-hub-publication-recovery button").isEnabled())
        .toBe(true);
      await dialog.locator(".skill-hub-publication-recovery button").click();
      await expect.poll(() => dialog.locator('[name="version"]').inputValue()).toBe("7.0.0");
      expect(await dialog.locator(".skill-hub-target-label").textContent()).toBe(originalLabel);
      await dialog.locator("button.primary").click();
      await expect
        .poll(() => dialog.locator(".skill-hub-publication-recovery button").isEnabled())
        .toBe(true);
      await expect.poll(() => page.locator(".skill-hub-pending-publication").count()).toBe(1);
      expect(requests[2]).toEqual(requests[0]);
      expect(effects).toEqual(["vm-two"]);
      await dialog.locator("button.primary").click();
      await expect.poll(() => requests.length).toBe(4);
      expect(requests[3]).toEqual(requests[0]);
      expect(effects).toEqual(["vm-two", "vm-one"]);
      await expect.poll(() => dialog.count()).toBe(0);
      expect(executionMutations).toEqual([]);
    },
  );

  it.each(locales)(
    "blocks an install after another tab switches VM and keeps Basic independent in %s",
    async (locale) => {
      const { page, active, originalLabel, inventories, executionMutations } = await newPage(
        locale,
        390,
      );
      inventories.assigned_vm = [];
      inventories.platform_server = [];
      const requests: Array<Record<string, unknown>> = [];
      const effects: string[] = [];
      await page.route("**/platformclaw/api/skill-hub/skills/by-id/*/install", (route) => {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        requests.push(body);
        const current = body.destination === "assigned_vm" ? active.id : "platform-server";
        if (body.expectedTargetId !== undefined && body.expectedTargetId !== current) {
          return route.fulfill({
            status: 409,
            json: { error: "Execution target changed", details: { code: "skill-hub-changed" } },
          });
        }
        effects.push(current);
        return route.fulfill({
          json: {
            ok: true,
            slug: "release-checklist",
            version: body.version,
            target: body.destination,
          },
        });
      });
      await page.goto(`${suite.server.baseUrl}platformclaw/app/skills/hub`);
      await page.locator(".skill-hub-card").first().click();
      const detail = page.locator(".skill-hub-detail");
      const vm = detail.locator('[data-install-target="assigned_vm"]');
      const basic = detail.locator('[data-install-target="platform_server"]');
      await expect.poll(() => vm.locator("h4").textContent()).toContain(originalLabel);
      expect(await vm.locator("h4 b").count()).toBe(0);
      await capture(
        page,
        detail,
        `${locale}-install-long-vm-name-390`,
        vm.locator("button").first(),
      );
      Object.assign(active, { id: "vm-two", revision: 2, label: "Review VM two" });
      await vm.locator("button").first().click();
      await expect.poll(() => vm.locator("h4").textContent()).toContain("Review VM two");
      await expect.poll(() => vm.locator("button").first().isEnabled()).toBe(true);
      expect(requests[0]).toMatchObject({
        destination: "assigned_vm",
        expectedTargetId: "vm-one",
        expectedTargetRevision: 1,
      });
      expect(effects).toEqual([]);
      await vm.locator("button").first().click();
      await expect.poll(() => effects).toEqual(["vm-two"]);
      await expect.poll(() => basic.locator("button").isEnabled()).toBe(true);
      active.revision = 3;
      await basic.locator("button").click();
      await expect.poll(() => effects).toEqual(["vm-two", "platform-server"]);
      expect(requests[2]).toMatchObject({
        destination: "platform_server",
        expectedTargetId: "platform-server",
      });
      expect(requests[2]).not.toHaveProperty("expectedTargetRevision");
      expect(executionMutations).toEqual([]);
    },
  );

  it.each([
    { locale: "en-US", width: 320 },
    { locale: "ko-KR", width: 390 },
  ] as const)(
    "keeps a valid long ZIP filename and its diagnostic readable in $locale at $width pixels",
    async ({ locale, width }) => {
      const { page } = await newPage(locale, width);
      const labels = copy[locale];
      const fileName = `${"W".repeat(240)}.zip`;
      const diagnostic = `receipt-${"W".repeat(220)}`;
      const zip = new JSZip();
      zip.file(
        "SKILL.md",
        "---\nname: demo\ndescription: Synthetic UI proof\nversion: 1.0.0\n---\nReturn verified.\n",
      );
      const archive = await zip.generateAsync({ type: "nodebuffer" });
      const requests: Array<{ url: string; bytes: Buffer | null }> = [];
      await page.route("**/platformclaw/api/skill-hub/publish/upload?**", (route) => {
        requests.push({ url: route.request().url(), bytes: route.request().postDataBuffer() });
        return requests.length === 1
          ? route.fulfill({
              status: 503,
              json: { error: diagnostic, details: { code: "skill-hub-publication-pending" } },
            })
          : route.fulfill({ json: { id: "zip-entry", slug: "demo", version: "1.0.0" } });
      });
      await page.goto(`${suite.server.baseUrl}platformclaw/app/skills/hub`);
      await page.getByRole("button", { name: labels.upload, exact: true }).click();
      const dialog = page.locator(".skill-hub-upload");
      await dialog
        .locator('input[type="file"]')
        .setInputFiles({ name: fileName, mimeType: "application/zip", buffer: archive });
      await dialog.locator('[name="slug"]').fill("demo");
      await dialog.locator("button.primary").click();
      await expect
        .poll(() => dialog.locator(".skill-hub-publication-recovery button").isEnabled())
        .toBe(true);
      expect(await dialog.getByRole("alert").textContent()).toContain(diagnostic);
      expect(await dialog.locator(".skill-hub-upload__drop strong").textContent()).toBe(fileName);
      await capture(
        page,
        dialog,
        `${locale}-long-zip-diagnostic-${width}`,
        dialog.locator("button.primary"),
      );
      await dialog.getByRole("button", { name: labels.close, exact: true }).click();
      await page.getByRole("button", { name: labels.upload, exact: true }).click();
      await dialog.locator(".skill-hub-publication-recovery button").click();
      expect(await dialog.locator(".skill-hub-upload__drop strong").textContent()).toBe(fileName);
      await capture(
        page,
        dialog,
        `${locale}-long-zip-restored-${width}`,
        dialog.locator("button.primary"),
      );
      await dialog.locator("button.primary").click();
      await expect.poll(() => dialog.count()).toBe(0);
      expect(requests).toHaveLength(2);
      expect(requests[1]).toEqual(requests[0]);
      expect(requests[1]!.bytes).toEqual(archive);
    },
  );
});
