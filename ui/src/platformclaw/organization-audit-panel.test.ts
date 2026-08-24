import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import { formatDateTimeMs } from "../lib/format.ts";
import { loadAllPlatformClawLocales } from "./i18n.ts";
import { translations as english } from "./locales/en-guide.ts";
import { translations as korean } from "./locales/ko.ts";
import "./organization-audit-panel.ts";

type AuditPanel = HTMLElement & {
  fetchImpl: typeof fetch;
  onAuthorizationLost: () => void;
  updateComplete: Promise<unknown>;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function auditItem(key: string, occurredAt = 1_000) {
  return {
    key,
    action: "scope.renamed",
    category: "scope",
    occurredAt,
    outcome: "succeeded",
    reason: "Clarify ownership",
    actor: { accountId: "admin", displayName: "Admin", status: "active" },
    target: {
      type: "scope",
      scope: { kind: "group", name: "Runtime", status: "active" },
      lineage: [
        { kind: "team", name: "Platform", status: "active" },
        { kind: "group", name: "Runtime", status: "active" },
      ],
    },
    change: { beforeName: "Core", resultName: "Runtime" },
  };
}

async function settle(element: AuditPanel): Promise<void> {
  await element.updateComplete;
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  await element.updateComplete;
}

afterEach(async () => {
  document.body.replaceChildren();
  await i18n.setLocale("en");
});

beforeAll(() => loadAllPlatformClawLocales());

describe("PlatformClaw organization audit", () => {
  it("shows retry without a false empty state after the initial request fails", async () => {
    let attempts = 0;
    const element = document.createElement("platformclaw-organization-audit-panel") as AuditPanel;
    element.fetchImpl = vi.fn(async () => {
      attempts += 1;
      return attempts === 1 ? json({ error: "unavailable" }, 503) : json({ items: [] });
    });
    document.body.append(element);
    await settle(element);

    expect(element.querySelector('[role="alert"]')).not.toBeNull();
    expect(element.textContent).not.toContain("No organization audit events");
    element.querySelector<HTMLButtonElement>('[role="alert"] button')!.click();
    await settle(element);
    expect(element.textContent).toContain("No organization audit events");
  });

  it("pages with an opaque cursor, deduplicates records, and applies server filters", async () => {
    const urls: string[] = [];
    const element = document.createElement("platformclaw-organization-audit-panel") as AuditPanel;
    element.fetchImpl = vi.fn(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      urls.push(url);
      if (url.includes("cursor=next")) {
        return json({ items: [auditItem("one"), auditItem("two", 900)] });
      }
      if (url.includes("category=membership")) {
        return json({ items: [] });
      }
      return json({ items: [auditItem("one")], nextCursor: "next" });
    });
    document.body.append(element);
    await settle(element);
    element.querySelector<HTMLButtonElement>("button.btn:last-of-type")!.click();
    await settle(element);
    expect(element.querySelectorAll(".organization-audit-list > li")).toHaveLength(2);

    const category = element.querySelector<HTMLSelectElement>('select[name="category"]')!;
    category.value = "membership";
    category.dispatchEvent(new Event("change", { bubbles: true }));
    await settle(element);
    expect(urls.at(-1)).toContain("category=membership");
    const restoredCategory = element.querySelector<HTMLSelectElement>('select[name="category"]')!;
    expect(restoredCategory.value).toBe("membership");
    const outcome = element.querySelector<HTMLSelectElement>('select[name="outcome"]')!;
    outcome.value = "denied";
    outcome.dispatchEvent(new Event("change", { bubbles: true }));
    await settle(element);
    expect(urls.at(-1)).toContain("category=membership");
    expect(urls.at(-1)).toContain("outcome=denied");
  });

  it("retries a failed cursor without discarding previously loaded audit events", async () => {
    const urls: string[] = [];
    let failedCursor = false;
    const element = document.createElement("platformclaw-organization-audit-panel") as AuditPanel;
    element.fetchImpl = vi.fn(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      urls.push(url);
      if (!url.includes("cursor=next")) {
        return json({ items: [auditItem("one")], nextCursor: "next" });
      }
      if (!failedCursor) {
        failedCursor = true;
        return json({ error: "temporarily unavailable" }, 503);
      }
      return json({ items: [{ ...auditItem("two", 900), outcome: "denied" }] });
    });
    document.body.append(element);
    await settle(element);
    element.querySelector<HTMLButtonElement>("button.btn:last-of-type")!.click();
    await settle(element);
    expect(element.querySelectorAll(".organization-audit-list > li")).toHaveLength(1);
    element.querySelector<HTMLButtonElement>('[role="alert"] button')!.click();
    await settle(element);
    expect(urls.filter((url) => url.includes("cursor=next"))).toHaveLength(2);
    expect(element.querySelectorAll(".organization-audit-list > li")).toHaveLength(2);
    expect(element.querySelectorAll(".organization-audit-list summary")[1]?.textContent).toContain(
      "Denied",
    );
  });

  it("clears audit data and reports authority loss after a 403", async () => {
    const lost = vi.fn();
    const element = document.createElement("platformclaw-organization-audit-panel") as AuditPanel;
    element.onAuthorizationLost = lost;
    element.fetchImpl = vi.fn(async () => json({ error: "forbidden" }, 403));
    document.body.append(element);
    await settle(element);
    expect(lost).toHaveBeenCalledOnce();
    expect(element.querySelector(".organization-audit-list")).toBeNull();
  });

  it("keeps English and Korean audit labels in parity", () => {
    for (const auditKey of Object.keys(english).filter((key) =>
      key.includes("organization.audit"),
    )) {
      expect(korean[auditKey]).toBeTruthy();
    }
    expect(korean["platformClaw.organization.audit.action.scope.renamed"]).toBe("범위 이름 변경");
  });

  it("renders translated Korean audit actions, filters, and locale-aware timestamps", async () => {
    await i18n.setLocale("ko");
    const element = document.createElement("platformclaw-organization-audit-panel") as AuditPanel;
    element.fetchImpl = vi.fn(async () => json({ items: [auditItem("one")] }));
    document.body.append(element);
    await settle(element);
    expect(element.textContent).toContain("범위 이름 변경");
    expect(element.textContent).toContain("분류");
    expect(element.querySelector("time")?.textContent?.trim()).toBe(formatDateTimeMs(1_000));
  });
});
