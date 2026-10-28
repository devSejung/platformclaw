import { mkdir } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installSkillHubFixture } from "./skill-hub-installation.e2e.test-helpers.ts";

const proofDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "skill-hub-recovery");
const locales = ["en-US", "ko-KR"] as const;
const copy = {
  "en-US": {
    publish: "Publish workspace skill",
    upload: "Upload ZIP",
    close: "Close",
    restore: "Restore original request",
    cancel: "Cancel pending publication",
    cancelled: "Pending publication cancelled.",
    pending: "The publication result is still being confirmed.",
    invalidVersion: "Use a version number such as 1.0.0, then retry.",
    connection: "The connection was interrupted.",
    diagnostics: "Error details:",
    unconfirmedUpload: "An earlier upload with these settings is unconfirmed.",
  },
  "ko-KR": {
    publish: "작업 공간 스킬 게시",
    upload: "ZIP 업로드",
    close: "닫기",
    restore: "원래 요청 복원",
    cancel: "대기 중인 게시 취소",
    cancelled: "대기 중인 게시를 취소했습니다.",
    pending: "게시 결과를 확인 중입니다.",
    invalidVersion: "버전 번호를 1.0.0과 같은 형식으로 입력한 뒤 다시 시도하세요.",
    connection: "연결이 끊겼습니다.",
    diagnostics: "오류 정보:",
    unconfirmedUpload: "같은 설정의 이전 업로드 결과를 확인하지 못했습니다.",
  },
};
const suite = createControlUiE2eSuite({
  name: "Skill Hub original publication request recovery",
  unavailableMessage: (executablePath) => `Playwright Chromium unavailable at ${executablePath}`,
  trackBrowserContexts: true,
});

async function newPage(width: number, locale: (typeof locales)[number]) {
  await mkdir(proofDir, { recursive: true });
  const context = await suite.newBrowserContext({
    locale,
    serviceWorkers: "block",
    viewport: { width, height: 1000 },
  });
  const page = await context.newPage();
  const fixture = await installSkillHubFixture(page, suite.server.baseUrl);
  fixture.config.scopes = [{ id: "another-part", kind: "part", name: "Another Part" }];
  fixture.inventories.platform_server = [{ skillKey: "basic-demo", revision: "basic-r1" }];
  fixture.inventories.assigned_vm = [{ skillKey: "vm-demo", revision: "vm-r1" }];
  return { page, ...fixture };
}

async function captureUsableDialog(page: Page, dialog: Locator, name: string) {
  await dialog.locator("button.primary").scrollIntoViewIfNeeded();
  const metrics = await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const primary = element.querySelector<HTMLButtonElement>("button.primary")!;
    const button = primary.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      width: innerWidth,
      height: innerHeight,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
      primaryTop: button.top,
      primaryBottom: button.bottom,
    };
  });
  expect(metrics.left).toBeGreaterThanOrEqual(0);
  expect(metrics.right).toBeLessThanOrEqual(metrics.width + 1);
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
  expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.width + 1);
  expect(metrics.primaryTop).toBeGreaterThanOrEqual(0);
  expect(metrics.primaryBottom).toBeLessThanOrEqual(metrics.height + 1);
  await page.screenshot({ path: path.join(proofDir, `${name}.png`), animations: "disabled" });
}

suite.define(() => {
  it.each(
    locales.flatMap((locale) =>
      (["completed", "pending", "invalid"] as const).map((outcome) => ({ locale, outcome })),
    ),
  )(
    "handles a reselected ZIP after $outcome without duplicating publication in $locale",
    async ({ locale, outcome }) => {
      const { page, config } = await newPage(390, locale);
      const labels = copy[locale];
      const zip = new JSZip();
      zip.file(
        "SKILL.md",
        "---\nname: demo\ndescription: Synthetic reselection proof\nversion: 1.0.0\n---\nReturn verified.\n",
      );
      const archive = await zip.generateAsync({ type: "nodebuffer" });
      const file = { name: "demo.zip", mimeType: "application/zip", buffer: archive };
      const requests: Array<{ url: URL; bytes: Buffer | null }> = [];
      const effects = new Set<string>();
      let original = "";
      let cancelled = false;
      await page.route("**/platformclaw/api/skill-hub/publish/upload?**", (route) => {
        const url = new URL(route.request().url());
        const operation = url.searchParams.get("operationId")!;
        requests.push({ url, bytes: route.request().postDataBuffer() });
        if (requests.length === 1) {
          original = operation;
          if (outcome === "invalid") {
            return route.fulfill({
              status: 400,
              json: {
                error: "Invalid synthetic ZIP",
                details: { code: "skill-hub-invalid-archive" },
              },
            });
          }
          if (outcome === "pending") {
            config.pendingPublications = [
              {
                operationId: operation,
                skillId: "pending-entry",
                actorUserId: "person.one",
                displayName: "Demo",
                version: "1.0.0",
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
                error: "Receipt unavailable",
                details: { code: "skill-hub-publication-pending" },
              },
            });
          }
          effects.add(operation);
          return route.abort("failed");
        }
        effects.add(operation);
        return route.fulfill({ json: { id: "entry-demo", slug: "demo", version: "1.0.0" } });
      });
      await page.route("**/platformclaw/api/skill-hub/publications/*/cancel", (route) => {
        expect(new URL(route.request().url()).pathname).toBe(
          `/platformclaw/api/skill-hub/publications/${original}/cancel`,
        );
        cancelled = true;
        config.pendingPublications = [];
        return route.fulfill({ json: { ok: true } });
      });
      await page.goto(`${suite.server.baseUrl}platformclaw/app/skills/hub`);
      await page.getByRole("button", { name: labels.upload, exact: true }).click();
      const dialog = page.locator(".skill-hub-upload");
      await dialog
        .locator('input[type="file"]')
        .setInputFiles(
          outcome === "invalid" ? { ...file, buffer: Buffer.from("invalid archive") } : file,
        );
      await dialog.locator('[name="slug"]').fill("demo");
      await dialog.locator("button.primary").click();
      await expect
        .poll(() => dialog.locator(".skill-hub-publication-recovery button").count())
        .toBe(1);
      await dialog.locator('input[type="file"]').setInputFiles(file);
      await dialog.locator("button.primary").click();
      if (outcome === "invalid") {
        await expect.poll(() => dialog.count()).toBe(0);
        expect(requests).toHaveLength(2);
        expect(requests[1]!.url.searchParams.get("operationId")).not.toBe(original);
        expect(requests[1]!.bytes).toEqual(archive);
        expect(effects.size).toBe(1);
        return;
      }
      await expect
        .poll(() => dialog.getByRole("alert").textContent())
        .toContain(labels.unconfirmedUpload);
      expect(requests).toHaveLength(1);
      expect(await dialog.locator(".skill-hub-upload__drop strong").textContent()).toBe("demo.zip");
      await captureUsableDialog(page, dialog, `${locale}-${outcome}-reselection-guard`);
      if (outcome === "pending") {
        await dialog.getByRole("button", { name: labels.close, exact: true }).click();
        await page.getByRole("button", { name: labels.cancel, exact: true }).click();
        await expect.poll(() => cancelled).toBe(true);
        await expect.poll(() => page.locator(".skill-hub-pending-publication").count()).toBe(0);
        await page.getByRole("button", { name: labels.upload, exact: true }).click();
        await dialog.locator('input[type="file"]').setInputFiles(file);
        await dialog.locator('[name="slug"]').fill("demo");
      } else {
        await dialog.locator(".skill-hub-publication-recovery button").click();
      }
      await dialog.locator("button.primary").click();
      await expect.poll(() => dialog.count()).toBe(0);
      expect(requests).toHaveLength(2);
      if (outcome === "completed") {
        expect(requests[1]).toEqual(requests[0]);
      } else {
        expect(requests[1]!.url.searchParams.get("operationId")).not.toBe(original);
      }
      expect(requests[1]!.bytes).toEqual(archive);
      expect(effects.size).toBe(1);
    },
  );

  it.each(
    locales.flatMap((locale) =>
      (
        [
          { source: "platform_server", width: 320 },
          { source: "assigned_vm", width: 390 },
          { source: "platform_server", width: 1440 },
        ] as const
      ).map((entry) => ({ locale, source: entry.source, width: entry.width })),
    ),
  )(
    "recovers the original $source request in $locale after editing and reopening at $width pixels",
    async ({ source, width, locale }) => {
      const { page, config, executionMutations } = await newPage(width, locale);
      const labels = copy[locale];
      const requests: Array<Record<string, unknown>> = [];
      await page.route("**/platformclaw/api/skill-hub/publish", async (route) => {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        requests.push(body);
        if (requests.length < 3) {
          config.pendingPublications = [
            {
              operationId: String(requests[0]!.operationId),
              skillId: "pending-entry",
              actorUserId: "person.one",
              displayName: String(body.skill),
              version: "1.0.0",
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
              error: "Opaque registry receipt diagnostic",
              details: { code: "skill-hub-publication-pending" },
            },
          });
        }
        config.pendingPublications = [];
        return route.fulfill({
          json: { id: "completed-entry", slug: body.skill, version: body.version },
        });
      });
      await page.goto(`${suite.server.baseUrl}platformclaw/app/skills/hub`);
      await page.getByRole("button", { name: labels.publish, exact: true }).click();
      const dialog = page.locator(".skill-hub-workspace-publish");
      await dialog.locator('[name="source"]').selectOption(source);
      await expect.poll(() => dialog.locator("button.primary").isEnabled()).toBe(true);
      await dialog.locator('[name="sharing"]').selectOption("PRIVATE");
      await dialog.locator("button.primary").click();
      await expect
        .poll(() => dialog.locator(".skill-hub-publication-recovery button").count())
        .toBe(1);
      await expect.poll(() => page.locator(".skill-hub-pending-publication").count()).toBe(1);
      const error = await dialog.getByRole("alert").textContent();
      expect(error).toContain(labels.pending);
      expect(error).toContain(labels.diagnostics);
      expect(error).toContain("Opaque registry receipt diagnostic");
      expect(
        (await dialog.locator(".skill-hub-publication-recovery button").textContent())?.trim(),
      ).toBe(labels.restore);
      const originalId = String(requests[0]!.operationId);
      await dialog.locator('[name="version"]').fill("2.0.0");
      await dialog.locator("button.primary").click();
      await expect.poll(() => requests.length).toBe(2);
      await expect.poll(() => dialog.locator("button.primary").isEnabled()).toBe(true);
      expect(requests[1]!.operationId).not.toBe(originalId);
      await dialog.getByRole("button", { name: labels.close, exact: true }).click();
      await page.getByRole("button", { name: labels.publish, exact: true }).click();
      await expect.poll(() => dialog.locator("button.primary").isEnabled()).toBe(true);
      await dialog.locator(`[data-operation-id="${originalId}"]`).click();
      expect(await dialog.locator('[name="source"]').inputValue()).toBe(source);
      expect(await dialog.locator('[name="skill"]').inputValue()).toBe(
        source === "platform_server" ? "basic-demo" : "vm-demo",
      );
      expect(await dialog.locator('[name="version"]').inputValue()).toBe("1.0.0");
      expect(await dialog.locator('[name="sharing"]').inputValue()).toBe("PRIVATE");
      await captureUsableDialog(page, dialog, `${locale}-${source}-${width}-restored`);
      await dialog.locator("button.primary").click();
      await expect.poll(() => requests.length).toBe(3);
      expect(requests[2]).toEqual(requests[0]);
      await expect.poll(() => dialog.count()).toBe(0);
      await expect.poll(() => page.locator(".skill-hub-pending-publication").count()).toBe(0);
      expect(executionMutations).toEqual([]);
    },
  );

  it.each(locales.flatMap((locale) => [320, 390, 1440].map((width) => ({ locale, width }))))(
    "restores original ZIP bytes in $locale at $width pixels after a lost response and selecting another file",
    async ({ locale, width }) => {
      const { page } = await newPage(width, locale);
      const labels = copy[locale];
      const requests: Array<{ url: URL; body: Buffer | null }> = [];
      await page.route("**/platformclaw/api/skill-hub/publish/upload?**", async (route) => {
        requests.push({
          url: new URL(route.request().url()),
          body: route.request().postDataBuffer(),
        });
        if (requests.length < 3) {
          return route.abort("failed");
        }
        return route.fulfill({ json: { id: "completed-zip", slug: "demo", version: "1.0.0" } });
      });
      await page.goto(`${suite.server.baseUrl}platformclaw/app/skills/hub`);
      await page.getByRole("button", { name: labels.upload, exact: true }).click();
      const dialog = page.locator(".skill-hub-upload");
      await dialog.locator('input[type="file"]').setInputFiles({
        name: "demo.zip",
        mimeType: "application/zip",
        buffer: Buffer.from("original bytes"),
      });
      await dialog.locator('[name="slug"]').fill("demo");
      await dialog.locator("button.primary").click();
      await expect
        .poll(() => dialog.locator(".skill-hub-publication-recovery button").count())
        .toBe(1);
      expect(await dialog.getByRole("alert").textContent()).toContain(labels.connection);
      const originalId = requests[0]!.url.searchParams.get("operationId")!;
      await dialog.locator('input[type="file"]').setInputFiles({
        name: "demo.zip",
        mimeType: "application/zip",
        buffer: Buffer.from("changed bytes!"),
      });
      await dialog.locator('[name="version"]').fill("2.0.0");
      await dialog.locator("button.primary").click();
      await expect.poll(() => requests.length).toBe(2);
      await expect.poll(() => dialog.locator("button.primary").isEnabled()).toBe(true);
      expect(requests[1]!.url.searchParams.get("operationId")).not.toBe(originalId);
      await dialog.getByRole("button", { name: labels.close, exact: true }).click();
      await page.getByRole("button", { name: labels.upload, exact: true }).click();
      await dialog.locator(`[data-operation-id="${originalId}"]`).click();
      await expect.poll(() => dialog.locator("button.primary").isEnabled()).toBe(true);
      expect(await dialog.locator(".skill-hub-upload__drop strong").textContent()).toBe("demo.zip");
      await captureUsableDialog(page, dialog, `${locale}-zip-${width}-original-restored`);
      await dialog.locator("button.primary").click();
      await expect.poll(() => requests.length).toBe(3);
      expect(requests[2]!.url.href).toBe(requests[0]!.url.href);
      expect(requests[2]!.body).toEqual(Buffer.from("original bytes"));
      await expect.poll(() => dialog.count()).toBe(0);
    },
  );

  it.each(locales)(
    "explains an invalid version in %s without losing the draft or inventing pending state",
    async (locale) => {
      const { page } = await newPage(390, locale);
      const labels = copy[locale];
      const requests: Array<Record<string, unknown>> = [];
      await page.route("**/platformclaw/api/skill-hub/publish", (route) => {
        requests.push(route.request().postDataJSON() as Record<string, unknown>);
        return requests.length === 1
          ? route.fulfill({
              status: 400,
              json: {
                error: "Opaque version diagnostic",
                details: { code: "skill-hub-invalid-version" },
              },
            })
          : route.fulfill({ json: { id: "valid-entry", slug: "vm-demo", version: "1.0.0" } });
      });
      await page.goto(`${suite.server.baseUrl}platformclaw/app/skills/hub`);
      await page.getByRole("button", { name: labels.publish, exact: true }).click();
      const dialog = page.locator(".skill-hub-workspace-publish");
      await expect.poll(() => dialog.locator("button.primary").isEnabled()).toBe(true);
      await dialog.locator('[name="version"]').fill("invalid-version");
      await dialog.locator('[name="sharing"]').selectOption("PRIVATE");
      await dialog.locator("button.primary").click();
      await expect.poll(() => dialog.locator("button.primary").isEnabled()).toBe(true);
      const error = await dialog.getByRole("alert").textContent();
      expect(error).toContain(labels.invalidVersion);
      expect(error).toContain(labels.diagnostics);
      expect(error).toContain("Opaque version diagnostic");
      expect(await dialog.locator('[name="version"]').inputValue()).toBe("invalid-version");
      expect(await dialog.locator('[name="sharing"]').inputValue()).toBe("PRIVATE");
      expect(await page.locator(".skill-hub-pending-publication").count()).toBe(0);
      await captureUsableDialog(page, dialog, `${locale}-invalid-version-draft`);
      await dialog.locator('[name="version"]').fill("1.0.0");
      await dialog.locator("button.primary").click();
      await expect.poll(() => requests.length).toBe(2);
      await expect.poll(() => dialog.count()).toBe(0);
      expect(requests[1]!.operationId).not.toBe(requests[0]!.operationId);
      expect(requests[1]).toMatchObject({
        skill: "vm-demo",
        source: "assigned_vm",
        sharing: { mode: "PRIVATE", userIds: [], scopeIds: [] },
      });
    },
  );

  it.each(locales)(
    "restores selected organization sharing and cancels only the pending request in %s",
    async (locale) => {
      const { page, config } = await newPage(390, locale);
      const labels = copy[locale];
      let operationId = "";
      const cancelled: string[] = [];
      await page.route("**/platformclaw/api/skill-hub/publish", (route) => {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        operationId = String(body.operationId);
        expect(body.sharing).toEqual({ mode: "SELECTED", userIds: [], scopeIds: ["another-part"] });
        config.pendingPublications = [
          {
            operationId,
            skillId: "pending-entry",
            actorUserId: "person.one",
            displayName: "Selected skill",
            version: "1.0.0",
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
            error: "Opaque registry receipt diagnostic",
            details: { code: "skill-hub-publication-pending" },
          },
        });
      });
      await page.route("**/platformclaw/api/skill-hub/publications/*/cancel", (route) => {
        cancelled.push(new URL(route.request().url()).pathname);
        config.pendingPublications = [];
        return route.fulfill({ json: { ok: true } });
      });
      await page.goto(`${suite.server.baseUrl}platformclaw/app/skills/hub`);
      await page.getByRole("button", { name: labels.publish, exact: true }).click();
      const dialog = page.locator(".skill-hub-workspace-publish");
      await expect.poll(() => dialog.locator("button.primary").isEnabled()).toBe(true);
      await dialog.locator('[name="sharing"]').selectOption("SELECTED");
      await dialog.locator('[value="another-part"]').check();
      await dialog.locator("button.primary").click();
      const restore = dialog.locator(".skill-hub-publication-recovery button");
      await expect.poll(() => restore.isEnabled()).toBe(true);
      await dialog.locator('[name="sharing"]').selectOption("PRIVATE");
      await restore.click();
      expect(await dialog.locator('[name="sharing"]').inputValue()).toBe("SELECTED");
      expect(await dialog.locator('[value="another-part"]').isChecked()).toBe(true);
      await captureUsableDialog(page, dialog, `${locale}-selected-organization-restored`);
      await dialog.getByRole("button", { name: labels.close, exact: true }).click();
      await page.getByRole("button", { name: labels.cancel, exact: true }).click();
      await expect.poll(() => page.locator(".skill-hub-pending-publication").count()).toBe(0);
      await expect
        .poll(() => page.locator('[role="status"]').allTextContents())
        .toContainEqual(expect.stringContaining(labels.cancelled));
      expect(cancelled).toEqual([`/platformclaw/api/skill-hub/publications/${operationId}/cancel`]);
      await page.getByRole("button", { name: labels.publish, exact: true }).click();
      await expect.poll(() => dialog.locator("button.primary").isEnabled()).toBe(true);
      expect(await dialog.locator(".skill-hub-publication-recovery").count()).toBe(0);
    },
  );
});
