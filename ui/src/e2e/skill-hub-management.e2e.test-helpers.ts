import path from "node:path";
import type { Page } from "playwright";
import { expect } from "vitest";
import type {
  PlatformClawSkillHubDetail,
  PlatformClawSkillHubSearchItem,
} from "../platformclaw/skill-hub.ts";

export async function verifySkillHubManagement(page: Page, baseUrl: string, proofDir: string) {
  const employees = [
    {
      id: "employee-one",
      displayName: "Alex Employee With A Long Display Name",
      accountId: "alex.one",
    },
    {
      id: "employee-two",
      displayName: "Alex Employee With A Long Display Name",
      accountId: "alex.two.with.a.very.long.account.identifier",
    },
  ];
  const mutations: Array<{ path: string; body: unknown }> = [];
  const skill = {
    namespace: "engineering",
    slug: "demo",
    displayName: "Demo Skill",
    summary: "Published package",
    visibility: "PRIVATE",
    status: "PUBLISHED",
  } satisfies PlatformClawSkillHubDetail["skill"];
  const searchItem = { ...skill, latestVersion: "1.0.0" } satisfies PlatformClawSkillHubSearchItem;
  const detailResponse = {
    skill,
    versions: [{ version: "1.0.0", status: "PUBLISHED", downloadAvailable: true }],
    owner: { assigned: true, isMine: true, unassigned: false, revision: 42 },
    canManage: true,
    access: [],
  } satisfies PlatformClawSkillHubDetail;
  await page.route("**/platformclaw/api/skill-hub/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/config")) {
      return route.fulfill({ json: { namespaces: ["engineering"], maxPackageBytes: 1024 } });
    }
    if (url.pathname.endsWith("/management-users")) {
      const query = url.searchParams.get("q");
      if (query === "missing") {
        return route.fulfill({ json: { items: [] } });
      }
      if (query === "error") {
        return route.fulfill({ status: 503, json: { error: "Directory unavailable. Try again." } });
      }
      return route.fulfill({ json: { items: employees } });
    }
    if (route.request().method() === "POST") {
      mutations.push({ path: url.pathname, body: route.request().postDataJSON() });
      return route.fulfill({ json: { ownerUserId: "employee-two", ok: true } });
    }
    if (url.pathname.endsWith("/demo")) {
      return route.fulfill({
        json: detailResponse,
      });
    }
    return route.fulfill({ json: { items: [searchItem], total: 1 } });
  });
  await page.goto(`${baseUrl}platformclaw/app/skills/hub`);
  await page.locator(".skill-hub-card").click();
  const detail = page.locator(".skill-hub-detail");
  for (const purpose of ["owner", "access"] as const) {
    const picker = detail.locator(`openclaw-skill-hub-user-picker[purpose="${purpose}"]`);
    const input = picker.getByRole("combobox");
    const action = detail.getByRole("button", {
      name: purpose === "owner" ? "Transfer owner" : "Grant access",
      exact: true,
    });
    expect(await input.getAttribute("aria-label")).toContain("Search by name or account ID");
    await input.fill("missing");
    await expect.poll(() => picker.getByRole("status").textContent()).toContain("Searching");
    await expect
      .poll(() => picker.getByRole("status").textContent())
      .toContain("No eligible employees");
    await input.fill("error");
    await expect
      .poll(() => picker.getByRole("alert").textContent())
      .toContain("Directory unavailable");
    await input.fill("alex");
    await expect.poll(() => picker.getByRole("option").count()).toBe(2);
    expect(await action.isDisabled()).toBe(true);
    await input.press("ArrowDown");
    await input.press("ArrowDown");
    const active = await input.getAttribute("aria-activedescendant");
    expect(active).toBe(`skill-hub-${purpose}-users-1`);
    expect(await page.locator(`[id="${active}"]`).getAttribute("aria-selected")).toBe("true");
    await input.press("Escape");
    expect(await detail.isVisible()).toBe(true);
    expect(await input.getAttribute("aria-expanded")).toBe("false");
    await input.fill("alex.two");
    await expect.poll(() => picker.getByRole("option").count()).toBe(2);
    for (const width of [1920, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1080 });
      // Reproduce the reported narrow management card independently of viewport width.
      await picker.evaluate((element) => {
        (element.closest(".skill-hub-management__group") as HTMLElement).style.maxWidth = "280px";
      });
      const geometry = await picker.evaluate((element) => {
        const group = element.closest(".skill-hub-management__group")!;
        const boundary = group.getBoundingClientRect();
        return [...group.querySelectorAll("input, button")].every((control) => {
          const rect = control.getBoundingClientRect();
          return rect.left >= boundary.left && rect.right <= boundary.right + 1;
        });
      });
      expect(geometry).toBe(true);
      expect(await input.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(
        "rgb(255, 255, 255)",
      );
      await picker.scrollIntoViewIfNeeded();
      await page.screenshot({
        animations: "disabled",
        path: path.join(proofDir, `17-${purpose}-autocomplete-${width}.png`),
      });
    }
    await input.press("ArrowUp");
    await input.press("Enter");
    expect(await input.inputValue()).toContain(employees[1]!.accountId);
    expect(await action.isEnabled()).toBe(true);
    await input.fill("Alex");
    expect(await action.isDisabled()).toBe(true);
    await expect.poll(() => picker.getByRole("option").count()).toBe(2);
    await picker.getByRole("option").nth(1).click();
    await action.click();
    await expect
      .poll(() => detail.textContent())
      .toContain(purpose === "owner" ? "ownership transferred" : "access granted");
  }
  expect(mutations).toEqual([
    {
      path: "/platformclaw/api/skill-hub/skills/engineering/demo/owner",
      body: { ownerUserId: "employee-two", expectedOwnerUpdatedAt: 42 },
    },
    {
      path: "/platformclaw/api/skill-hub/skills/engineering/demo/access",
      body: { userId: "employee-two", inheritVersions: true },
    },
  ]);
}
