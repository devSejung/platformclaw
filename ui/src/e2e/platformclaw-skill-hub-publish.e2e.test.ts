import { mkdir } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { expect, it } from "vitest";
import { skillHubDetail, skillHubEntry } from "../pages/skill-hub/skill-hub.test-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installSkillHubFixture } from "./skill-hub-installation.e2e.test-helpers.ts";

const proofDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "skill-hub-sharing");
const suite = createControlUiE2eSuite({
  name: "Skill Hub employee sharing policy",
  unavailableMessage: (executablePath) => `Playwright Chromium unavailable at ${executablePath}`,
  trackBrowserContexts: true,
});

async function newPage(locale = "en-US") {
  await mkdir(proofDir, { recursive: true });
  const context = await suite.newBrowserContext({
    locale,
    serviceWorkers: "block",
    viewport: { width: 1440, height: 1000 },
    recordVideo: { dir: proofDir, size: { width: 1440, height: 1000 } },
  });
  const page = await context.newPage();
  const fixture = await installSkillHubFixture(page, suite.server.baseUrl);
  fixture.inventories.platform_server = [{ skillKey: "basic-demo" }];
  fixture.inventories.assigned_vm = [{ skillKey: "vm-demo" }];
  fixture.config.scopes = [{ id: "another-part", kind: "part", name: "Another Part" }];
  const published: Array<Record<string, unknown>> = [];
  await page.route("**/platformclaw/api/skill-hub/publish", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    published.push(body);
    return route.fulfill({
      json: { id: "33333333-3333-4333-8333-333333333333", slug: body.skill, version: body.version },
    });
  });
  return { page, published, ...fixture };
}

suite.define(() => {
  it.each([
    { locale: "en-US", source: "platform_server" },
    { locale: "en-US", source: "assigned_vm" },
    { locale: "ko-KR", source: "platform_server" },
    { locale: "ko-KR", source: "assigned_vm" },
  ] as const)(
    "publishes company-wide from $source in $locale without namespace setup",
    async ({ locale, source }) => {
      const { page, published, executionMutations, gateway } = await newPage(locale);
      await page.goto(`${suite.server.baseUrl}platformclaw/app/skills/hub`);
      await page
        .getByRole("button", {
          name: locale === "ko-KR" ? "작업 공간 스킬 게시" : "Publish workspace skill",
          exact: true,
        })
        .click();
      const dialog = page.locator(".skill-hub-workspace-publish");
      await dialog.locator('[name="source"]').selectOption(source);
      const slug = source === "assigned_vm" ? "vm-demo" : "basic-demo";
      await expect.poll(() => dialog.locator('[name="skill"]').inputValue()).toBe(slug);
      expect(await dialog.locator('[name="sharing"]').inputValue()).toBe("PUBLIC");
      expect(await dialog.locator('[name="namespace"]').count()).toBe(0);
      await page.screenshot({
        path: path.join(proofDir, `${locale}-${source}-default.png`),
        animations: "disabled",
      });
      await dialog.locator("button.primary").click();
      await expect.poll(() => published.length).toBe(1);
      expect(published[0]).toMatchObject({
        skill: slug,
        source,
        sharing: { mode: "PUBLIC", userIds: [], scopeIds: [] },
      });
      expect(published[0]).not.toHaveProperty("namespace");
      await expect.poll(() => dialog.count()).toBe(0);
      expect(executionMutations).toEqual([]);
      expect(await gateway.getRequests("platformclaw-execution.changeTarget")).toEqual([]);
    },
  );

  it.each([320, 390, 1440])(
    "keeps member publishing actions reachable at %ipx and the catalog near its search",
    async (width) => {
      const { page, executionMutations } = await newPage("ko-KR");
      await page.setViewportSize({ width, height: 900 });
      await page.route("**/platformclaw/api/skill-hub/search?**", (route) =>
        route.fulfill({
          json: {
            total: 1,
            items: [
              skillHubEntry({
                slug: "release-checklist",
                displayName: "release-checklist",
                summary: "기본 서버와 VM에서 사용할 검증 체크리스트",
              }),
            ],
          },
        }),
      );
      for (const panel of ["trash", "transfers", "notifications"]) {
        await page.route(`**/platformclaw/api/skill-hub/${panel}`, (route) =>
          route.fulfill({ json: { items: [], unreadCount: 0 } }),
        );
      }
      await page.goto(`${suite.server.baseUrl}platformclaw/app/skills/hub`);
      const header = page.locator(".content--skill-hub .content-header--page");
      const actions = ["작업 공간 스킬 게시", "ZIP 업로드", "휴지통", "소유권 요청", "알림"];
      for (const name of actions) {
        const action = header.getByRole("button", { name, exact: true });
        await action.waitFor({ state: "visible" });
        const reachable = await action.evaluate((button) => {
          const rect = button.getBoundingClientRect();
          const bounds = button.closest(".content-header--page")!.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          return {
            contained: rect.top >= bounds.top && rect.bottom <= bounds.bottom,
            hit: hit !== null && button.contains(hit),
          };
        });
        expect(reachable).toEqual({ contained: true, hit: true });
        await action.click();
        const dialog = page.locator("openclaw-skill-hub-page openclaw-modal-dialog");
        await dialog.waitFor({ state: "visible" });
        await dialog.getByRole("button", { name: "닫기", exact: true }).click();
        await dialog.waitFor({ state: "detached" });
      }
      const search = page.getByRole("searchbox", { name: "스킬 허브 검색", exact: true });
      await search.fill("release");
      await search.press("Enter");
      await page
        .locator(".skill-hub-card")
        .getByText("release-checklist", { exact: true })
        .waitFor();
      await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe("release");
      expect(executionMutations).toEqual([]);
      await page.screenshot({ path: path.join(proofDir, `member-catalog-${width}.png`) });
    },
  );

  it("permits another Part, blocks empty selected sharing, and preserves drafts after a rejected publish", async () => {
    const { page, published } = await newPage();
    let fail = true;
    await page.route("**/platformclaw/api/skill-hub/publish", async (route) => {
      if (fail) {
        fail = false;
        return route.fulfill({
          status: 503,
          json: { error: "Registry unavailable; retry this publication." },
        });
      }
      return route.fallback();
    });
    await page.goto(`${suite.server.baseUrl}platformclaw/app/skills/hub`);
    await page.getByRole("button", { name: "Publish workspace skill", exact: true }).click();
    const dialog = page.locator(".skill-hub-workspace-publish");
    await expect.poll(() => dialog.locator('[name="skill"]').inputValue()).toBe("vm-demo");
    await dialog.locator('[name="sharing"]').selectOption("SELECTED");
    expect(await dialog.locator("button.primary").isDisabled()).toBe(true);
    await dialog.locator('input[value="another-part"]').check();
    await dialog.locator("button.primary").click();
    await expect
      .poll(() => dialog.locator('[role="alert"]').textContent())
      .toContain("Registry unavailable");
    expect(await dialog.locator('input[value="another-part"]').isChecked()).toBe(true);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: path.join(proofDir, "selected-part-retry-mobile.png"),
      animations: "disabled",
    });
    await dialog.locator("button.primary").click();
    await expect.poll(() => published.length).toBe(1);
    expect(published[0]).toMatchObject({
      sharing: { mode: "SELECTED", userIds: [], scopeIds: ["another-part"] },
    });
  });

  it.each([390, 1440])(
    "recovers a metadata conflict without losing work or reopening sharing at %ipx",
    async (width) => {
      const { page } = await newPage();
      await page.setViewportSize({ width, height: 900 });
      let entry = skillHubEntry();
      const writes: Array<Record<string, unknown>> = [];
      await page.route("**/platformclaw/api/skill-hub/search?**", (route) =>
        route.fulfill({ json: { items: [entry], total: 1 } }),
      );
      await page.route("**/platformclaw/api/skill-hub/skills/by-id/**", async (route) => {
        if (route.request().method() === "PATCH") {
          const body = route.request().postDataJSON() as Record<string, unknown>;
          writes.push(body);
          if (writes.length === 1) {
            entry = {
              ...entry,
              revision: 8,
              summary: "Latest saved description",
              sharing: { mode: "PRIVATE" },
            };
            return route.fulfill({
              status: 409,
              json: { error: "Skill changed; reload before editing." },
            });
          }
          expect(body).toMatchObject({
            expectedRevision: 8,
            summary: "Keep my draft",
            tags: ["draft"],
          });
          expect(body).not.toHaveProperty("sharing");
          entry = { ...entry, revision: 9, summary: "Keep my draft", tags: ["draft"] };
          return route.fulfill({ json: { ok: true } });
        }
        return route.fulfill({
          json: skillHubDetail({
            skill: entry,
            sharing: { mode: entry.sharing.mode, userIds: [], scopeIds: [], users: [], scopes: [] },
          }),
        });
      });
      await page.goto(`${suite.server.baseUrl}platformclaw/app/skills/hub`);
      await page.locator(".skill-hub-card").click();
      await page.getByRole("button", { name: "Edit skill", exact: true }).click();
      const editor = page.locator(".skill-hub-edit");
      await editor.locator('[name="summary"]').fill("Keep my draft");
      await editor.locator('[name="tags"]').fill("draft");
      const save = editor.getByRole("button", { name: "Save changes", exact: true });
      await save.click();
      await editor.getByRole("alert").waitFor();
      expect(await save.isDisabled()).toBe(true);
      await editor.getByRole("button", { name: "Reload latest", exact: true }).click();
      await expect
        .poll(() => editor.locator(".skill-hub-edit-latest").textContent())
        .toContain("Latest saved description");
      expect(await editor.locator('[name="summary"]').inputValue()).toBe("Keep my draft");
      expect(await editor.locator('[name="sharing"]').inputValue()).toBe("PRIVATE");
      expect(writes).toHaveLength(1);
      expect(
        await editor.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      ).toBe(true);
      await page.screenshot({
        path: path.join(proofDir, `edit-conflict-${width}.png`),
        animations: "disabled",
      });
      await save.click();
      await editor.waitFor({ state: "detached" });
      expect(writes).toHaveLength(2);
      await expect
        .poll(() => page.locator(".skill-hub-detail").textContent())
        .toContain("Keep my draft");
      expect(entry.sharing.mode).toBe("PRIVATE");
    },
  );

  it("lets a member remove an archived organization without making the skill public", async () => {
    const { page } = await newPage();
    await page.setViewportSize({ width: 390, height: 900 });
    let entry = skillHubEntry({ sharing: { mode: "SELECTED" } });
    let selected = "archived-part";
    const patches: Array<Record<string, unknown>> = [];
    await page.route("**/platformclaw/api/skill-hub/search?**", (route) =>
      route.fulfill({ json: { items: [entry], total: 1 } }),
    );
    await page.route("**/platformclaw/api/skill-hub/skills/by-id/**", async (route) => {
      if (route.request().method() === "PATCH") {
        const body = route.request().postDataJSON();
        patches.push(body);
        if (body.sharing) {
          expect(body.sharing).toEqual({
            mode: "SELECTED",
            userIds: [],
            scopeIds: ["another-part"],
          });
          selected = "another-part";
        }
        entry = { ...entry, summary: body.summary, revision: entry.revision + 1 };
        return route.fulfill({ json: { ok: true } });
      }
      return route.fulfill({
        json: skillHubDetail({
          skill: entry,
          sharing: {
            mode: "SELECTED",
            userIds: [],
            scopeIds: [selected],
            users: [],
            scopes: [
              {
                id: selected,
                kind: "part",
                name: selected === "archived-part" ? "Archived Part" : "Another Part",
              },
            ],
          },
        }),
      });
    });
    await page.goto(`${suite.server.baseUrl}platformclaw/app/skills/hub`);
    await page.locator(".skill-hub-card").click();
    const edit = page.getByRole("button", { name: "Edit skill", exact: true });
    await edit.click();
    const editor = page.locator(".skill-hub-edit");
    await editor.locator('[name="summary"]').fill("Metadata still works");
    await editor.getByRole("button", { name: "Save changes", exact: true }).click();
    await editor.waitFor({ state: "detached" });
    expect(patches[0]).not.toHaveProperty("sharing");
    await edit.click();
    await editor.locator(".skill-hub-unavailable-scopes").waitFor();
    expect(await editor.locator('[name="sharing"]').inputValue()).toBe("SELECTED");
    await page.screenshot({
      path: path.join(proofDir, "archived-organization-mobile.png"),
      animations: "disabled",
    });
    await editor
      .getByRole("button", { name: "Remove unavailable organization Archived Part", exact: true })
      .click();
    const save = editor.getByRole("button", { name: "Save changes", exact: true });
    expect(await save.isDisabled()).toBe(true);
    await editor.locator('[value="another-part"]').check();
    await save.click();
    await editor.waitFor({ state: "detached" });
    expect(patches).toHaveLength(2);
    expect(entry.sharing.mode).toBe("SELECTED");
  });

  it("edits catalog description and tags, uploads an icon, and restores from trash", async () => {
    const { page } = await newPage();
    let entry = skillHubEntry();
    let deleted = false;
    await page.route("**/platformclaw/api/skill-hub/search?**", (route) =>
      route.fulfill({ json: { items: deleted ? [] : [entry], total: deleted ? 0 : 1 } }),
    );
    await page.route("**/platformclaw/api/skill-hub/trash", (route) =>
      route.fulfill({
        json: { items: deleted ? [{ ...entry, deletedAt: 1000, purgeAt: 2592001000 }] : [] },
      }),
    );
    await page.route("**/platformclaw/api/skill-hub/skills/by-id/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/delete")) {
        deleted = true;
        entry = { ...entry, revision: entry.revision + 1 };
        return route.fulfill({ json: { ok: true } });
      }
      if (url.pathname.endsWith("/restore")) {
        deleted = false;
        entry = { ...entry, revision: entry.revision + 1 };
        return route.fulfill({ json: { ok: true } });
      }
      if (url.pathname.endsWith("/icon")) {
        if (route.request().method() === "PUT") {
          entry = {
            ...entry,
            iconUrl: `/platformclaw/api/skill-hub/skills/by-id/${entry.id}/icon`,
            revision: entry.revision + 1,
          };
          return route.fulfill({ json: { ok: true } });
        }
        return route.fulfill({
          contentType: "image/png",
          body: Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1sAAAAASUVORK5CYII=",
            "base64",
          ),
        });
      }
      if (route.request().method() === "PATCH") {
        const body = route.request().postDataJSON() as { summary: string; tags: string[] };
        entry = { ...entry, summary: body.summary, tags: body.tags, revision: entry.revision + 1 };
        return route.fulfill({ json: { ok: true } });
      }
      return route.fulfill({ json: skillHubDetail({ skill: entry }) });
    });
    await page.goto(`${suite.server.baseUrl}platformclaw/app/skills/hub`);
    await page.locator(".skill-hub-card").click();
    await page.getByRole("button", { name: "Edit skill", exact: true }).click();
    const editor = page.locator(".skill-hub-edit");
    await editor.locator('[name="summary"]').fill("Team-ready release guide");
    await editor.locator('[name="tags"]').fill("release, docs");
    await editor.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect
      .poll(() => page.locator(".skill-hub-detail").textContent())
      .toContain("Team-ready release guide");
    await page.locator('input[name="icon"]').setInputFiles({
      name: "icon.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1sAAAAASUVORK5CYII=",
        "base64",
      ),
    });
    await expect.poll(() => page.locator(".skill-hub-detail img").count()).toBe(1);
    await page.screenshot({
      path: path.join(proofDir, "metadata-icon.png"),
      animations: "disabled",
    });
    await page
      .locator(".skill-hub-detail")
      .getByRole("button", { name: "Move to trash", exact: true })
      .click();
    await page
      .locator(".skill-hub-dialog")
      .filter({ has: page.getByRole("button", { name: "Cancel", exact: true }) })
      .getByRole("button", { name: "Move to trash", exact: true })
      .click();
    await expect.poll(() => page.locator(".skill-hub-card").count()).toBe(0);
    await page.getByRole("button", { name: "Trash", exact: true }).click();
    await page.getByRole("button", { name: "Restore", exact: true }).click();
    await expect.poll(() => page.locator(".skill-hub-card").count()).toBe(1);
    expect(entry.sharing.mode).toBe("PUBLIC");
  });

  it("uploads ZIP as a new public skill without extra metadata", async () => {
    const { page } = await newPage();
    const uploads: URL[] = [];
    await page.route("**/platformclaw/api/skill-hub/publish/upload?**", (route) => {
      uploads.push(new URL(route.request().url()));
      return route.fulfill({
        json: { id: "44444444-4444-4444-8444-444444444444", slug: "zip-demo", version: "1.0.0" },
      });
    });
    const zip = new JSZip();
    zip.file(
      "SKILL.md",
      "---\nname: zip-demo\ndescription: Synthetic UI proof\nversion: 1.0.0\n---\nReturn verified.\n",
    );
    await page.goto(`${suite.server.baseUrl}platformclaw/app/skills/hub`);
    await page.getByRole("button", { name: "Upload ZIP", exact: true }).click();
    const dialog = page.locator(".skill-hub-upload");
    await dialog.locator('input[type="file"]').setInputFiles({
      name: "zip-demo.zip",
      mimeType: "application/zip",
      buffer: await zip.generateAsync({ type: "nodebuffer" }),
    });
    await dialog.locator('[name="slug"]').fill("zip-demo");
    expect(await dialog.locator('[name="sharing"]').inputValue()).toBe("PUBLIC");
    await dialog.getByRole("button", { name: "Publish", exact: true }).click();
    await expect.poll(() => uploads.length).toBe(1);
    expect(JSON.parse(uploads[0]!.searchParams.get("sharing")!)).toEqual({
      mode: "PUBLIC",
      userIds: [],
      scopeIds: [],
    });
    expect(uploads[0]!.searchParams.has("namespace")).toBe(false);
  });
});
