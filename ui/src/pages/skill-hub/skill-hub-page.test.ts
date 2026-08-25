/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import "./skill-hub-page.ts";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("SkillHubPage", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it("searches, opens an exact version, and exposes separate Basic and VM installs", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ namespaces: ["engineering"], maxPackageBytes: 524_288_000 }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          total: 1,
          items: [
            {
              namespace: "engineering",
              slug: "release-notes",
              latestVersion: "2.1.0",
              summary: "Draft company release notes.",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          skill: {
            namespace: "engineering",
            slug: "release-notes",
            displayName: "Release Notes",
            summary: "Draft company release notes.",
            visibility: "NAMESPACE_ONLY",
            status: "PUBLISHED",
          },
          versions: [
            { version: "2.1.0", status: "PUBLISHED", downloadAvailable: true },
            { version: "2.0.0", status: "YANKED", downloadAvailable: false },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          slug: "release-notes",
          version: "2.1.0",
          target: "platform_server",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const page = document.createElement("openclaw-skill-hub-page");
    document.body.append(page);

    await waitForFast(() => expect(page.textContent).toContain("release-notes"));
    page.querySelector<HTMLButtonElement>(".skill-hub-card")?.click();
    await waitForFast(() => expect(page.textContent).toContain("Release Notes"));

    expect(page.textContent).toContain("Install to Basic Workspace");
    expect(page.textContent).toContain("Install to My VM Workspace");
    const buttons = [...page.querySelectorAll<HTMLButtonElement>("button")];
    buttons.find((button) => button.textContent?.includes("Basic Workspace"))?.click();
    await waitForFast(() => expect(page.textContent).toContain("Installed release-notes@2.1.0"));

    expect(fetchMock).toHaveBeenLastCalledWith(
      expect.stringContaining("/install"),
      expect.objectContaining({
        body: JSON.stringify({
          namespace: "engineering",
          slug: "release-notes",
          version: "2.1.0",
          destination: "platform_server",
        }),
        method: "POST",
      }),
    );
  });

  it("publishes an assigned-VM skill from the Skill Hub without switching the active workspace", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/config")) {
        return jsonResponse({
          namespaces: ["engineering"],
          maxPackageBytes: 524_288_000,
          activeTarget: "platform_server",
          installTargets: [
            { target: "platform_server", available: true, status: "ready" },
            { target: "assigned_vm", available: true, status: "ready" },
          ],
        });
      }
      if (url.includes("/workspace-skills?source=platform_server")) {
        return jsonResponse({
          source: "platform_server",
          items: [{ skillKey: "basic-skill", version: "1.0.0" }],
        });
      }
      if (url.includes("/workspace-skills?source=assigned_vm")) {
        return jsonResponse({
          source: "assigned_vm",
          items: [{ skillKey: "vm-release", name: "VM Release", version: "2.3.0" }],
        });
      }
      if (url.endsWith("/publish") && init?.method === "POST") {
        return jsonResponse({ namespace: "engineering", slug: "vm-release", version: "2.3.0" });
      }
      return jsonResponse({ total: 0, items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const page = document.createElement("openclaw-skill-hub-page");
    document.body.append(page);
    await waitForFast(() => expect(page.textContent).toContain("Publish workspace skill"));

    [...page.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Publish workspace skill"))
      ?.click();
    await waitForFast(() => expect(page.textContent).toContain("basic-skill"));
    const source = page.querySelector<HTMLSelectElement>(".skill-hub-workspace-publish select")!;
    source.value = "assigned_vm";
    source.dispatchEvent(new Event("change", { bubbles: true }));
    await waitForFast(() => expect(page.textContent).toContain("VM Release (vm-release)"));
    expect(
      page.querySelectorAll<HTMLSelectElement>(".skill-hub-workspace-publish select")[1]?.value,
    ).toBe("vm-release");

    [...page.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Scan and publish skill"))
      ?.click();
    await waitForFast(() =>
      expect(page.textContent).toContain(
        "Published engineering/vm-release@2.3.0 from My VM workspace",
      ),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/publish"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          skill: "vm-release",
          source: "assigned_vm",
          namespace: "engineering",
          version: "2.3.0",
          visibility: "NAMESPACE_ONLY",
        }),
      }),
    );
    expect(
      fetchMock.mock.calls.some(([input]) =>
        (input instanceof Request ? input.url : input.toString()).includes("/execution"),
      ),
    ).toBe(false);
  });

  it("defaults workspace publishing to the active assigned VM", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/config")) {
        return jsonResponse({
          namespaces: ["engineering"],
          maxPackageBytes: 1024,
          activeTarget: "assigned_vm",
          installTargets: [
            { target: "platform_server", available: true, status: "ready" },
            { target: "assigned_vm", available: true, status: "ready" },
          ],
        });
      }
      if (url.includes("/workspace-skills")) {
        return jsonResponse({ source: "assigned_vm", items: [{ skillKey: "vm-only" }] });
      }
      return jsonResponse({ total: 0, items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const page = document.createElement("openclaw-skill-hub-page");
    document.body.append(page);
    await waitForFast(() => expect(page.textContent).toContain("Publish workspace skill"));

    [...page.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Publish workspace skill"))
      ?.click();
    await waitForFast(() => expect(page.textContent).toContain("vm-only"));

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/workspace-skills?source=assigned_vm"),
      expect.any(Object),
    );
    expect(
      page.querySelector<HTMLSelectElement>(".skill-hub-workspace-publish select")?.value,
    ).toBe("assigned_vm");
  });

  it("opens the persistent notification inbox and marks all items read", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          namespaces: ["engineering"],
          maxPackageBytes: 1024,
          notifications: { unreadCount: 1 },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ total: 0, items: [] }))
      .mockResolvedValueOnce(
        jsonResponse({
          unreadCount: 1,
          items: [
            {
              id: "notice-1",
              kind: "scanner-risk",
              namespace: "engineering",
              slug: "release-notes",
              message: "Scanner found a high-risk command.",
              createdAt: 1_700_000_000_000,
              readAt: null,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true, updated: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    const page = document.createElement("openclaw-skill-hub-page");
    document.body.append(page);
    await waitForFast(() => expect(page.textContent).toContain("No Skill Hub results"));

    [...page.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Notifications"))
      ?.click();
    await waitForFast(() =>
      expect(page.textContent).toContain("Scanner found a high-risk command"),
    );
    [...page.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Mark all read"))
      ?.click();
    await waitForFast(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(
        expect.stringContaining("/notifications/read"),
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("requires a second confirmation before replacing an installed version", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ namespaces: ["engineering"], maxPackageBytes: 524_288_000 }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          total: 1,
          items: [
            {
              namespace: "engineering",
              slug: "release-notes",
              latestVersion: "2.1.0",
              summary: "Draft company release notes.",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          skill: {
            namespace: "engineering",
            slug: "release-notes",
            displayName: "Release Notes",
            summary: "Draft company release notes.",
            visibility: "NAMESPACE_ONLY",
            status: "PUBLISHED",
          },
          versions: [{ version: "2.1.0", status: "PUBLISHED", downloadAvailable: true }],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: "version change requires confirmation",
            details: {
              code: "version-change-required",
              currentVersion: "2.0.0",
              requestedVersion: "2.1.0",
              direction: "upgrade",
            },
          },
          409,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          slug: "release-notes",
          version: "2.1.0",
          target: "platform_server",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const page = document.createElement("openclaw-skill-hub-page");
    document.body.append(page);
    await waitForFast(() => expect(page.textContent).toContain("release-notes"));
    page.querySelector<HTMLButtonElement>(".skill-hub-card")?.click();
    await waitForFast(() => expect(page.textContent).toContain("Install to Basic Workspace"));
    [...page.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Install to Basic Workspace"))
      ?.click();
    await waitForFast(() => expect(page.textContent).toContain("Confirm version change"));
    [...page.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Replace installed version"))
      ?.click();
    await waitForFast(() => expect(page.textContent).toContain("Installed release-notes@2.1.0"));
    expect(fetchMock).toHaveBeenLastCalledWith(
      expect.stringContaining("/install"),
      expect.objectContaining({
        body: JSON.stringify({
          namespace: "engineering",
          slug: "release-notes",
          version: "2.1.0",
          destination: "platform_server",
          acknowledgedVersionChange: true,
          currentVersion: "2.0.0",
        }),
      }),
    );
  });

  it("lets an administrator bind namespaces to managed scopes and inspect unassigned owners", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/config")) {
        return jsonResponse({
          namespaces: ["engineering"],
          maxPackageBytes: 524_288_000,
          admin: true,
          unassignedOwnerCount: 1,
        });
      }
      if (url.includes("/admin/namespaces")) {
        return jsonResponse({
          bindings: [],
          scopes: [{ id: "part-platform", kind: "part", name: "Platform Part" }],
        });
      }
      if (url.includes("/admin/unassigned")) {
        return jsonResponse({
          items: [
            {
              namespace: "engineering",
              slug: "release-notes",
              visibility: "NAMESPACE_ONLY",
              currentVersion: "2.1.0",
              changedAt: 1_700_000_000_000,
            },
          ],
        });
      }
      return jsonResponse({ total: 0, items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const page = document.createElement("openclaw-skill-hub-page");
    document.body.append(page);
    await waitForFast(() => expect(page.textContent).toContain("Skill Hub admin"));

    [...page.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Skill Hub admin"))
      ?.click();
    await waitForFast(() => expect(page.textContent).toContain("engineering/release-notes"));
    expect(page.textContent).toContain("Namespace access");
    expect(page.textContent).toContain("Unassigned owners");
  });

  it("drops stale management search state when switching skills", async () => {
    let resolveCandidates!: (response: Response) => void;
    const pendingCandidates = new Promise<Response>((resolve) => {
      resolveCandidates = resolve;
    });
    const detail = (slug: string) => ({
      skill: {
        namespace: "engineering",
        slug,
        displayName: slug === "skill-a" ? "Skill A" : "Skill B",
        summary: "Managed skill",
        visibility: "NAMESPACE_ONLY",
        status: "PUBLISHED",
      },
      versions: [{ version: "1.0.0", status: "PUBLISHED", downloadAvailable: true }],
      owner: { assigned: true, isMine: true, unassigned: false, revision: 10 },
      canManage: true,
      access: [],
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/config")) {
        return jsonResponse({ namespaces: ["engineering"], maxPackageBytes: 1024 });
      }
      if (url.includes("/management-users")) {
        return await pendingCandidates;
      }
      if (url.endsWith("/skills/engineering/skill-a")) {
        return jsonResponse(detail("skill-a"));
      }
      if (url.endsWith("/skills/engineering/skill-b")) {
        return jsonResponse(detail("skill-b"));
      }
      return jsonResponse({
        total: 2,
        items: [
          { namespace: "engineering", slug: "skill-a", latestVersion: "1.0.0", summary: "A" },
          { namespace: "engineering", slug: "skill-b", latestVersion: "1.0.0", summary: "B" },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const page = document.createElement("openclaw-skill-hub-page");
    document.body.append(page);
    await waitForFast(() => expect(page.textContent).toContain("skill-a"));
    page.querySelectorAll<HTMLButtonElement>(".skill-hub-card")[0]?.click();
    await waitForFast(() => expect(page.textContent).toContain("Skill A"));
    const search = [...page.querySelectorAll<HTMLInputElement>("input")].find(
      (input) => input.placeholder === "Search by name or account ID",
    )!;
    search.value = "eligible";
    search.dispatchEvent(new InputEvent("input", { bubbles: true }));
    [...page.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Close")
      ?.click();
    page.querySelectorAll<HTMLButtonElement>(".skill-hub-card")[1]?.click();
    await waitForFast(() => expect(page.textContent).toContain("Skill B"));
    resolveCandidates(
      jsonResponse({
        items: [{ id: "candidate-a", accountId: "candidate.a", displayName: "Candidate A" }],
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(page.textContent).not.toContain("Candidate A");
    const transfer = [...page.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("Transfer owner"),
    );
    expect(transfer?.disabled).toBe(true);
  });

  it("warns when a ZIP reaches the registry but needs ownership review", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ namespaces: ["engineering"], maxPackageBytes: 1024 }))
      .mockResolvedValueOnce(jsonResponse({ total: 0, items: [] }))
      .mockResolvedValueOnce(
        jsonResponse({
          namespace: "engineering",
          slug: "demo",
          version: "1.0.0",
          ownershipReviewRequired: true,
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ total: 0, items: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const page = document.createElement("openclaw-skill-hub-page");
    document.body.append(page);
    await waitForFast(() => expect(page.textContent).toContain("No Skill Hub results"));
    const internal = page as unknown as {
      uploadFile: File;
      uploadSlug: string;
      uploadNamespace: string;
      uploadVersion: string;
      uploadVisibility: string;
      publishZip(): Promise<void>;
    };
    internal.uploadFile = new File(["zip"], "demo.zip", { type: "application/zip" });
    internal.uploadSlug = "demo";
    internal.uploadNamespace = "engineering";
    internal.uploadVersion = "1.0.0";
    internal.uploadVisibility = "PUBLIC";
    await internal.publishZip();
    await waitForFast(() => expect(page.textContent).toContain("private until an administrator"));
    expect(page.querySelector(".callout.warning")).not.toBeNull();
  });
});
