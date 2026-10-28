import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { expect } from "vitest";
import { PLATFORMCLAW_WEB_GATEWAY_METHODS } from "../../../packages/platformclaw-control-plane/src/browser-gateway-policy.js";
import type { createSkillHubBasicVmLiveFixture } from "../../../packages/platformclaw-control-plane/src/skill-hub-basic-vm.test-helpers.js";
import { PLATFORMCLAW_WEB_DESCRIPTOR } from "../platformclaw/web-contract.js";
import {
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
} from "../test-helpers/control-ui-e2e.js";

type Fixture = Awaited<ReturnType<typeof createSkillHubBasicVmLiveFixture>>;
type Published = { id: string; slug: string; version: string };

/** Built UI and real BFF; the maintained fixture supplies only frontend discovery. */
export async function createSkillHubBuiltBrowserProof(fixture: Fixture, outputDirectory: string) {
  await mkdir(outputDirectory, { recursive: true });
  const uiRoot = path.resolve("dist/control-ui");
  const index = await readFile(path.join(uiRoot, "index.html"), "utf8");
  const html = index.replace(
    "<head>",
    `<head><base href="/platformclaw/app/"><meta name="platformclaw-web-descriptor" content='${JSON.stringify(PLATFORMCLAW_WEB_DESCRIPTOR)}'>`,
  );
  const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
  const servedAssets: Record<string, string> = {};
  const requests: Array<{ method: string; path: string; status: number }> = [];
  const errors: string[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const cookie = req.headers.cookie ?? "";
      if (url.pathname.startsWith("/platformclaw/api/skill-hub/")) {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.from(chunk));
        }
        const body = Buffer.concat(chunks);
        // Preserve browser cookie, origin, body, status and response bytes. The
        // production BrowserAuthService and mutation-origin check run in the BFF.
        const response = await fetch(`${fixture.browserOrigin}${url.pathname}${url.search}`, {
          method: req.method,
          headers: {
            cookie,
            origin: req.headers.origin ?? "",
            "content-type": req.headers["content-type"] ?? "application/json",
          },
          ...(body.length > 0 ? { body } : {}),
        });
        requests.push({
          method: req.method ?? "GET",
          path: `${url.pathname}${url.search}`,
          status: response.status,
        });
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
        return;
      }
      if (
        url.pathname === "/platformclaw/api/auth/session" ||
        url.pathname === "/platformclaw/api/execution"
      ) {
        const token = /(?:^|;\s*)platformclaw_session=([^;]+)/u.exec(cookie)?.[1];
        const actor = token ? await fixture.service.authenticate(token) : null;
        res.setHeader("content-type", "application/json");
        if (!actor) {
          res.writeHead(401).end(JSON.stringify({ authenticated: false }));
          return;
        }
        if (url.pathname.endsWith("/session")) {
          res.end(
            JSON.stringify({
              authenticated: true,
              user: {
                accountId: actor.user.accountId,
                displayName: actor.user.displayName ?? actor.user.accountId,
                department: "",
                globalRole: actor.user.globalRole,
              },
              agent: { agentId: actor.agentId, state: "active" },
              session: {
                idleExpiresAt: Date.now() + 60000,
                absoluteExpiresAt: Date.now() + 120000,
              },
            }),
          );
        } else {
          res.end(
            JSON.stringify(
              await fixture.executionService.getSettings(actor.user.id, actor.agentId),
            ),
          );
        }
        return;
      }
      let assetPath = url.pathname.replace(/^\/platformclaw\/app\//u, "").replace(/^\//u, "");
      if (!assetPath.startsWith("assets/")) {
        res.writeHead(200, { "content-type": "text/html" }).end(html);
        return;
      }
      assetPath = path.resolve(uiRoot, assetPath);
      if (!assetPath.startsWith(`${uiRoot}${path.sep}`) || !(await stat(assetPath)).isFile()) {
        res.writeHead(404).end();
        return;
      }
      const bytes = await readFile(assetPath);
      servedAssets[path.relative(uiRoot, assetPath)] = sha(bytes);
      res
        .writeHead(200, {
          "content-type": assetPath.endsWith(".css") ? "text/css" : "text/javascript",
        })
        .end(bytes);
    })().catch((error: unknown) => {
      errors.push(error instanceof Error ? error.message : "proof server error");
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
      }
      res.end(JSON.stringify({ error: "Built UI proof server failed" }));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing built UI listener");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  fixture.addBrowserOrigin(origin);
  const browser = await chromium.launch({
    executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
  });
  const pages = new Map<"author" | "reader", Page>();
  const pageFor = async (role: "author" | "reader") => {
    const old = pages.get(role);
    if (old) {
      return old;
    }
    const principal = fixture[role];
    const context = await browser.newContext({
      viewport: { width: 1600, height: 1000 },
      locale: role === "author" ? "en-US" : "ko-KR",
      serviceWorkers: "block",
    });
    await context.addCookies([
      {
        name: "platformclaw_session",
        value: principal.cookie,
        url: origin,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    const page = await context.newPage();
    // Discovery/connection bootstrap is a documented proof limitation. SkillHub
    // requests still reach the real BFF, Gateway Admin RPC and SSH transport.
    await installMockGateway(page, {
      basePath: "/platformclaw/app",
      defaultAgentId: principal.binding.agentId,
      sessionKey: `agent:${principal.binding.agentId}:main`,
      featureMethods: [...PLATFORMCLAW_WEB_GATEWAY_METHODS],
    });
    page.on("pageerror", (error) => errors.push(error.message));
    pages.set(role, page);
    return page;
  };
  return {
    async publish(source: "platform_server" | "assigned_vm", slug: string): Promise<Published> {
      const page = await pageFor("author");
      await page.goto(`${origin}/platformclaw/app/skills/hub`);
      await page.getByRole("button", { name: "Publish workspace skill", exact: true }).click();
      const dialog = page.locator(".skill-hub-workspace-publish");
      await dialog.locator('[name="source"]').selectOption(source);
      await dialog.locator('[name="skill"]').selectOption(slug);
      await expect.poll(() => dialog.locator('[name="skill"]').inputValue()).toBe(slug);
      expect(await dialog.locator('[name="sharing"]').inputValue()).toBe("PUBLIC");
      expect(await dialog.locator('[name="namespace"]').count()).toBe(0);
      await page.screenshot({
        path: path.join(outputDirectory, `${source}-public-default.png`),
        animations: "disabled",
      });
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      await dialog.getByRole("button", { name: "Publish", exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({
        path: path.join(outputDirectory, `${source}-public-default-mobile.png`),
        animations: "disabled",
      });
      const responseReady = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname.endsWith("/skill-hub/publish"),
      );
      await dialog.getByRole("button", { name: "Publish", exact: true }).click();
      const response = await responseReady;
      expect({ status: response.status(), body: await response.text() }).toMatchObject({
        status: 200,
      });
      const published = (await response.json()) as Published;
      await expect.poll(() => dialog.count()).toBe(0);
      await expect.poll(() => page.locator(".skill-hub-card", { hasText: slug }).count()).toBe(1);
      await page.screenshot({
        path: path.join(outputDirectory, `${source}-published-mobile.png`),
        animations: "disabled",
      });
      await page.setViewportSize({ width: 1600, height: 1000 });
      await page.screenshot({
        path: path.join(outputDirectory, `${source}-published.png`),
        animations: "disabled",
      });
      return published;
    },
    async installVm(skill: Pick<Published, "id" | "slug">): Promise<void> {
      const page = await pageFor("reader");
      await page.goto(`${origin}/platformclaw/app/skills/hub`);
      await expect.poll(() => page.locator("html").getAttribute("lang")).toBe("ko");
      const owner = fixture.author.user.displayName ?? fixture.author.user.accountId;
      await page
        .locator(".skill-hub-card", { hasText: skill.slug })
        .filter({ hasText: owner })
        .click();
      await expect.poll(() => new URL(page.url()).searchParams.get("skill")).toBe(skill.id);
      const target = page.locator('[data-install-target="assigned_vm"]');
      await expect.poll(() => target.locator("button").first().isEnabled()).toBe(true);
      await target.locator("button").first().click();
      await expect.poll(() => target.textContent()).toContain("1.0.0");
      await expect.poll(() => target.locator("button").first().isDisabled()).toBe(true);
      await expect.poll(() => target.textContent()).toContain("내 개발 VM");
      await page.screenshot({
        path: path.join(outputDirectory, "assigned_vm-installed.png"),
        animations: "disabled",
      });
      await page.setViewportSize({ width: 390, height: 844 });
      const detail = page.locator(".skill-hub-detail");
      expect(await detail.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      await target.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: path.join(outputDirectory, "assigned_vm-installed-mobile.png"),
        animations: "disabled",
      });
    },
    async close() {
      for (const [role, page] of pages) {
        await page.screenshot({
          path: path.join(outputDirectory, `${role}-final.png`),
          animations: "disabled",
        });
      }
      await browser.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await writeFile(
        path.join(outputDirectory, "browser-proof.json"),
        JSON.stringify(
          {
            builtIndexSha256: sha(index),
            servedHtmlSha256: sha(html),
            servedAssets,
            requests,
            errors,
            boundaries: {
              ui: "fresh production dist/control-ui",
              locales: "English author publication; Korean reader VM installation",
              authentication:
                "seeded actual BrowserAuthService SQLite sessions; cookie forwarded unchanged",
              skillHub: "real BFF, SQLite catalog, native artifacts, actual Gateway RPC and SSH",
              frontendBootstrap:
                "maintained discovery/connection fixture; not full SSO/browser Gateway proxy proof",
            },
          },
          null,
          2,
        ),
      );
      expect(errors).toEqual([]);
    },
  };
}
