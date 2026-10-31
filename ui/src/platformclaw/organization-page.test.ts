import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import type { OrganizationContext, OrganizationScopeResult } from "./organization-api.ts";
import "./organization-page.ts";

type OrganizationElement = HTMLElement & {
  fetchImpl: typeof fetch;
  onUnauthenticated: () => void;
  updateComplete: Promise<unknown>;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function scope(
  id: string,
  kind: "team" | "group" | "part",
  name: string,
  lineage: OrganizationScopeResult["lineage"],
  capabilities: OrganizationScopeResult["capabilities"],
): OrganizationScopeResult {
  return {
    id,
    kind,
    name,
    status: "active",
    revision: 10,
    lineage,
    capabilities,
    requestEligible: false,
    requestState: "member",
  };
}

const none = {
  canManageMembers: false,
  canManageStructure: false,
  canManageLeaders: false,
};

function fixtureFetch(options?: {
  manager?: boolean;
  administrator?: boolean;
  empty?: boolean;
  membershipConflict?: boolean;
  conflictRefresh?: Promise<void>;
  refreshFailsAfterMutation?: boolean;
  automatic?: boolean;
  directorySync?: OrganizationContext["directorySync"];
}) {
  let mutationCommitted = false;
  let membershipConflictObserved = false;
  const team = { id: "team-1", kind: "team" as const, name: "Platform", status: "active" as const };
  const group = {
    id: "group-1",
    kind: "group" as const,
    name: "Runtime",
    parentScopeId: team.id,
    status: "active" as const,
    ...(options?.automatic
      ? { managedBy: "ldap-login" as const, externalKey: "group:runtime" }
      : {}),
  };
  const secondGroup = { ...group, id: "group-2", externalKey: "group:runtime-two" };
  const managed =
    options?.manager || options?.administrator
      ? {
          canManageMembers: true,
          canManageStructure: !options?.automatic && options?.administrator === true,
          canManageLeaders: options?.administrator === true,
        }
      : none;
  return vi.fn<typeof fetch>(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/memberships") && options?.membershipConflict) {
      membershipConflictObserved = true;
      return json(
        { error: "organization membership changed", code: "organization_membership_changed" },
        409,
      );
    }
    if (url.endsWith("/memberships")) {
      mutationCommitted = true;
      return json({});
    }
    if (url.endsWith("/context")) {
      if (membershipConflictObserved) {
        await options?.conflictRefresh;
      }
      if (mutationCommitted && options?.refreshFailsAfterMutation) {
        return json({ error: "unavailable" }, 503);
      }
      return json({
        actor: {
          id: "user-1",
          displayName: "Person",
          isAdministrator: options?.administrator === true,
        },
        directMemberships: options?.empty
          ? []
          : [
              {
                scopeId: group.id,
                role: options?.manager ? "leader" : "member",
                ...(options?.automatic ? { managedBy: "ldap-login" } : {}),
              },
              ...(options?.automatic
                ? [{ scopeId: secondGroup.id, role: "member", managedBy: "ldap-login" }]
                : []),
            ],
        directMembershipsHasMore: false,
        directScopeLineages: options?.empty
          ? []
          : [
              { scopeId: group.id, lineage: [team, group] },
              ...(options?.automatic
                ? [{ scopeId: secondGroup.id, lineage: [team, secondGroup] }]
                : []),
            ],
        effectiveScopes: options?.empty
          ? []
          : [
              {
                scope: group,
                source: "direct",
                directRole: options?.manager ? "leader" : "member",
              },
              { scope: team, source: "ancestor" },
              ...(options?.automatic
                ? [{ scope: secondGroup, source: "direct", directRole: "member" }]
                : []),
            ],
        effectiveScopesHasMore: false,
        primaryScope: options?.empty ? null : group,
        primaryScopeLineage: options?.empty ? [] : [team, group],
        canReviewJoinRequests: options?.manager === true || options?.administrator === true,
        canManageOrganization: options?.manager === true || options?.administrator === true,
        canViewOrganizationAudit: options?.administrator === true,
        directorySync: options?.directorySync,
      });
    }
    if (url.includes("/scopes?")) {
      return json({
        items: options?.empty
          ? []
          : [
              scope(team.id, "team", team.name, [team], none),
              {
                ...scope(group.id, "group", group.name, [team, group], managed),
                ...(options?.automatic
                  ? { managedBy: group.managedBy, externalKey: group.externalKey }
                  : {}),
              },
              ...(options?.automatic
                ? [
                    {
                      ...scope(
                        secondGroup.id,
                        "group",
                        secondGroup.name,
                        [team, secondGroup],
                        managed,
                      ),
                      managedBy: secondGroup.managedBy,
                      externalKey: secondGroup.externalKey,
                    },
                  ]
                : []),
            ],
        hasMore: false,
      });
    }
    if (
      url.includes("/management/scopes/group-1?") ||
      url.includes("/management/scopes/group-2?")
    ) {
      return json({
        scope: url.includes("/group-2?") ? secondGroup : group,
        members: [
          {
            user: {
              id: "user-1",
              accountId: "person.one",
              displayName: "Person",
              status: "active",
            },
            role: options?.manager ? "leader" : "member",
            ...(options?.automatic
              ? { managedBy: "ldap-login", ...(mutationCommitted ? { manualRole: "member" } : {}) }
              : {}),
          },
        ],
      });
    }
    return json({ error: "unexpected" }, 500);
  });
}

async function mount(fetchImpl: typeof fetch): Promise<OrganizationElement> {
  const element = document.createElement("platformclaw-organization-page") as OrganizationElement;
  element.fetchImpl = fetchImpl;
  element.onUnauthenticated = vi.fn();
  document.body.append(element);
  await vi.waitFor(() =>
    expect(element.querySelector("#platformclaw-organization-tab-overview")).not.toBeNull(),
  );
  await element.updateComplete;
  return element;
}

async function selectTab(element: OrganizationElement, value: string): Promise<void> {
  element
    .querySelector(`#platformclaw-organization-tab-${value}`)
    ?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
  await element.updateComplete;
}

afterEach(async () => {
  document
    .querySelectorAll("platformclaw-organization-page")
    .forEach((element) => element.remove());
  await i18n.setLocale("en");
});

describe("PlatformClaw Organization settings", () => {
  it("renders server-projected lineage and hides management from ordinary members", async () => {
    const element = await mount(fixtureFetch());
    expect(element.textContent).toContain("Platform / Runtime");
    expect(element.textContent).not.toContain("Create a scope");
  });

  it.each([
    [{ status: "pending" }, "Your saved organization information is being checked"],
    [
      { status: "skipped", reason: "requires-authenticated-org" },
      "No verified organization information was saved",
    ],
    [
      { status: "failed", reason: "database-unavailable" },
      "Automatic organization synchronization failed",
    ],
    [
      { status: "skipped", reason: "no-organization" },
      "Sign-in succeeded without organization information",
    ],
    [
      { status: "skipped", reason: "untrusted-source" },
      "The sign-in organization source is not eligible",
    ],
    [
      { status: "skipped", reason: "unsupported-version" },
      "The sign-in organization format version is not supported",
    ],
    [
      { status: "skipped", reason: "test-account" },
      "Automatic organization membership is disabled for test accounts",
    ],
    [
      { status: "skipped", reason: "stale-organization" },
      "The sign-in organization information is older than the saved verified information",
    ],
    [
      { status: "skipped", reason: "conflicting-organization" },
      "The sign-in organization information conflicts with saved verified information",
    ],
  ] as const)(
    "shows the recorded automatic membership outcome without claiming an absent membership: %j",
    async (directorySync, message) => {
      const element = await mount(fixtureFetch({ empty: true, directorySync }));
      expect(element.textContent).toContain(message);
      expect(element.textContent).not.toContain("No organization membership");
      if ("reason" in directorySync) {
        expect(element.textContent).not.toContain(directorySync.reason);
      }
      expect(element.querySelector("#platformclaw-organization-tab-requests")).not.toBeNull();
      expect(element.querySelector('a[href^="/employee/auth/adsso"]')).toBeNull();
    },
  );

  it("keeps existing membership visible when automatic synchronization fails", async () => {
    const element = await mount(fixtureFetch({ directorySync: { status: "failed" } }));
    expect(element.textContent).toContain("Platform / Runtime");
    expect(element.textContent).toContain("Automatic organization synchronization failed");
  });

  it.each([
    ["requires-authenticated-org", "인증된 조직 정보가 저장되어 있지 않습니다"],
    ["no-organization", "인증 응답에 조직 정보가 없습니다"],
    ["untrusted-source", "조직 출처는 자동 가입에 사용할 수 없습니다"],
    ["unsupported-version", "조직 정보 버전을 지원하지 않습니다"],
    ["test-account", "테스트 계정에는 조직 자동 가입을 적용하지 않습니다"],
    ["stale-organization", "조직 정보가 저장된 인증 정보보다 오래되었습니다"],
    ["conflicting-organization", "인증 응답과 저장된 조직 정보가 서로 다릅니다"],
  ])(
    "explains the recorded automatic organization outcome in Korean: %s",
    async (reason, message) => {
      await i18n.setLocale("ko");
      const element = await mount(
        fixtureFetch({
          empty: true,
          directorySync: { status: "skipped", reason },
        }),
      );
      expect(element.textContent).toContain(message);
      expect(element.textContent).not.toContain("소속 조직 없음");
    },
  );

  it.each([
    ["en", "Continue to company sign-in", "Company sign-in may ask you to authenticate again"],
    ["ko", "회사 로그인으로 이동", "회사 로그인에서 다시 인증을 요청할 수 있습니다"],
  ] as const)(
    "offers the configured company sign-in route for unavailable legacy facts: %s",
    async (locale, label, prompt) => {
      await i18n.setLocale(locale);
      const refreshUrl =
        "/employee/auth/adsso?returnTo=%2Fplatformclaw%2Fapp%2Fsettings%2Forganization";
      const element = await mount(
        fixtureFetch({
          empty: true,
          directorySync: { status: "skipped", reason: "requires-authenticated-org", refreshUrl },
        }),
      );
      const action = element.querySelector<HTMLAnchorElement>('a[href^="/employee/auth/adsso"]');
      expect(action?.getAttribute("href")).toBe(refreshUrl);
      expect(action?.textContent).toContain(label);
      expect(element.textContent).toContain(prompt);
      expect(element.querySelector("#platformclaw-organization-tab-requests")).not.toBeNull();
    },
  );

  it("keeps recorded fresh exclusions separate from the legacy company sign-in action", async () => {
    const element = await mount(
      fixtureFetch({
        empty: true,
        directorySync: {
          status: "skipped",
          reason: "unsupported-version",
          refreshUrl: "/employee/auth/adsso",
        },
      }),
    );
    expect(element.querySelector('a[href^="/employee/auth/adsso"]')).toBeNull();
    expect(element.textContent).toContain("format version is not supported");
  });

  it("shows a directory Part before its parents are known and keeps its automatic structure read-only", async () => {
    const part = {
      id: "part-unmapped",
      kind: "part" as const,
      name: "Runtime",
      status: "active" as const,
      managedBy: "ldap-login" as const,
      externalKey: "aicm-part:runtime",
    };
    const capabilities = {
      canManageMembers: true,
      canManageLeaders: true,
      canManageStructure: false,
    };
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/context")) {
        return json({
          actor: { id: "user-1", displayName: "Person", isAdministrator: true },
          directMemberships: [{ scopeId: part.id, role: "member", managedBy: "ldap-login" }],
          directScopeLineages: [{ scopeId: part.id, lineage: [part] }],
          effectiveScopes: [{ scope: part, source: "direct", directRole: "member" }],
          directMembershipsHasMore: false,
          effectiveScopesHasMore: false,
          primaryScope: part,
          primaryScopeLineage: [part],
          isUnaffiliated: false,
          hasPendingJoinRequest: false,
          joinPromptEligible: false,
          canReviewJoinRequests: true,
          canManageOrganization: true,
          canViewOrganizationAudit: true,
        });
      }
      if (url.includes("/scopes?")) {
        return json({
          items: [
            {
              ...part,
              revision: 10,
              lineage: [part],
              capabilities,
              requestState: "member",
              requestEligible: false,
            },
          ],
          hasMore: false,
        });
      }
      if (url.includes("/management/scopes/part-unmapped?")) {
        return json({
          scope: part,
          members: [
            {
              user: { id: "user-1", accountId: "person.one", status: "active" },
              role: "member",
              managedBy: "ldap-login",
            },
          ],
        });
      }
      return json({ error: "unexpected" }, 500);
    });
    const element = await mount(fetchImpl);
    expect(element.textContent).toContain("Runtime (aicm-part:runtime)");
    expect(element.textContent).toContain("Automatically managed");
    const primary = element.querySelector<HTMLSelectElement>('select[aria-label="Primary scope"]')!;
    expect(
      [...primary.options]
        .filter((option) => option.value)
        .map((option) => option.textContent?.trim()),
    ).toEqual(["Runtime (aicm-part:runtime)"]);

    await selectTab(element, "management");

    await vi.waitFor(() => expect(element.textContent).toContain("person.one"));
    const actions = [...element.querySelectorAll("button")].map((button) =>
      button.textContent?.trim(),
    );
    expect(actions).not.toContain("Rename");
    expect(actions).not.toContain("Archive");
  });

  it("renders delegated roster controls from management capability", async () => {
    const fetchImpl = fixtureFetch({ manager: true });
    const element = await mount(fetchImpl);
    await selectTab(element, "management");
    await vi.waitFor(() => expect(element.textContent).toContain("person.one"));
    expect(element.textContent).toContain("Add a member");
    expect(element.textContent).not.toContain("Create a scope");
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining("/management/scopes/group-1?"),
      expect.objectContaining({ credentials: "same-origin" }),
    );
    const role = element.querySelector<HTMLSelectElement>('select[aria-label="Membership role"]');
    expect(role?.value).toBe("leader");
    if (role) {
      role.value = "member";
      role.dispatchEvent(new Event("change", { bubbles: true }));
    }
    await element.updateComplete;
    expect(role?.value).toBe("leader");
    expect(element.textContent).toContain("Platform / Runtime · Person · Member");
  });

  it("loads Korean product copy while keeping Team, Group, and Part terminology", async () => {
    await i18n.setLocale("ko");
    const element = await mount(fixtureFetch());
    await vi.waitFor(() => expect(element.textContent).toContain("내 조직"));
    expect(element.textContent).toContain("Group");
    expect(element.textContent).toContain("멤버");
  });

  it("distinguishes identical directory paths and keeps their structure read-only for admins", async () => {
    const fetchImpl = fixtureFetch({ administrator: true, automatic: true });
    const element = await mount(fetchImpl);
    expect(element.textContent).toContain("Automatically managed");
    const primary = element.querySelector<HTMLSelectElement>('select[aria-label="Primary scope"]')!;
    expect(
      [...primary.options]
        .filter((option) => option.value)
        .map((option) => option.textContent?.trim()),
    ).toEqual(["Platform / Runtime (group:runtime)", "Platform / Runtime (group:runtime-two)"]);

    await selectTab(element, "management");
    const picker = element.querySelector<HTMLSelectElement>('select[aria-label="Managed scope"]')!;
    expect([...picker.options].map((option) => option.value)).toEqual(["group-1", "group-2"]);
    expect([...picker.options].map((option) => option.textContent?.trim())).toEqual([
      "Platform / Runtime (group:runtime)",
      "Platform / Runtime (group:runtime-two)",
    ]);
    expect(element.textContent).toContain("Automatically managed");
    expect(
      [...element.querySelectorAll("button")].map((button) => button.textContent?.trim()),
    ).not.toContain("Rename");
    expect(
      [...element.querySelectorAll("button")].map((button) => button.textContent?.trim()),
    ).not.toContain("Archive");
    picker.value = "group-2";
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() =>
      expect(fetchImpl).toHaveBeenCalledWith(
        expect.stringContaining("/management/scopes/group-2?"),
        expect.objectContaining({ credentials: "same-origin" }),
      ),
    );
    expect(element.textContent).toContain("Add a member");
  });

  it("lets an administrator retain an automatic membership without changing its role", async () => {
    const fetchImpl = fixtureFetch({ administrator: true, automatic: true });
    const element = await mount(fetchImpl);
    await selectTab(element, "management");
    await vi.waitFor(() => expect(element.textContent).toContain("Keep manual membership"));
    [...element.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Keep manual membership")!
      .click();
    await element.updateComplete;
    const dialog = element.querySelector("openclaw-modal-dialog")!;
    expect(dialog.textContent).toContain("Confirm manual membership");
    dialog.querySelector("textarea")!.value = "Keep project access after directory moves";
    dialog.querySelector("form")!.dispatchEvent(new SubmitEvent("submit", { bubbles: true }));
    await vi.waitFor(() => expect(element.textContent).toContain("Manual membership retained"));
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining("/memberships"),
      expect.objectContaining({
        body: JSON.stringify({
          scopeId: "group-1",
          userId: "user-1",
          role: "member",
          expectedRole: "member",
          reason: "Keep project access after directory moves",
        }),
      }),
    );
    expect(element.textContent).not.toContain("Keep manual membership");
  });

  it("lets an administrator bootstrap the first Team without invalid parent controls", async () => {
    const element = await mount(fixtureFetch({ administrator: true, empty: true }));
    await selectTab(element, "management");
    expect(element.querySelector('form[aria-label="Create Team"]')).not.toBeNull();
    expect(element.querySelector('form[aria-label="Create Group"]')).toBeNull();
    expect(element.querySelector('form[aria-label="Create Team"] select')).toBeNull();
  });

  it("keeps both locale bundles available across a runtime locale switch", async () => {
    const element = await mount(fixtureFetch());
    expect(element.textContent).toContain("My organization");
    await i18n.setLocale("ko");
    await element.updateComplete;
    expect(element.textContent).toContain("내 조직");
    await i18n.setLocale("en");
    await element.updateComplete;
    expect(element.textContent).toContain("My organization");
  });

  it("sends expectedRole and restores authoritative roster after a 409", async () => {
    let releaseConflictRefresh!: () => void;
    const conflictRefresh = new Promise<void>((resolve) => {
      releaseConflictRefresh = resolve;
    });
    const fetchImpl = fixtureFetch({
      manager: true,
      membershipConflict: true,
      conflictRefresh,
    });
    const element = await mount(fetchImpl);
    await selectTab(element, "management");
    await vi.waitFor(() => expect(element.textContent).toContain("person.one"));
    const role = element.querySelector<HTMLSelectElement>('select[aria-label="Membership role"]')!;
    role.value = "member";
    role.dispatchEvent(new Event("change", { bubbles: true }));
    await element.updateComplete;
    const dialog = element.querySelector("openclaw-modal-dialog")!;
    const reason = dialog.querySelector("textarea")!;
    reason.value = "role correction";
    dialog.querySelector("form")!.dispatchEvent(new SubmitEvent("submit", { bubbles: true }));
    await vi.waitFor(() =>
      expect(
        fetchImpl.mock.calls.filter(([input]) => {
          const url =
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          return url.endsWith("/context");
        }),
      ).toHaveLength(2),
    );
    expect(element.querySelector("openclaw-modal-dialog")).toBe(dialog);
    expect(dialog.querySelector("textarea")?.value).toBe("role correction");
    expect(
      [...dialog.querySelectorAll<HTMLButtonElement>("button")].every((button) => button.disabled),
    ).toBe(true);
    releaseConflictRefresh();
    await vi.waitFor(() => expect(element.textContent).toContain("The roster changed"));
    const modalError = element
      .querySelector("openclaw-modal-dialog")
      ?.querySelector<HTMLElement>('[role="alert"]');
    expect(modalError?.textContent).toContain("The roster changed");
    expect(element.querySelector("openclaw-modal-dialog")).toBe(dialog);
    expect(dialog.querySelector("textarea")?.value).toBe("role correction");
    expect(document.activeElement).toBe(modalError);
    expect(
      fetchImpl.mock.calls.some(
        ([, init]) =>
          typeof init?.body === "string" && init.body.includes('"expectedRole":"leader"'),
      ),
    ).toBe(true);
    expect(
      element.querySelector<HTMLSelectElement>('select[aria-label="Membership role"]')?.value,
    ).toBe("leader");
  });

  it("closes the dialog and reports committed state when the authoritative reload fails", async () => {
    const element = await mount(fixtureFetch({ manager: true, refreshFailsAfterMutation: true }));
    await selectTab(element, "management");
    await vi.waitFor(() => expect(element.textContent).toContain("person.one"));
    const role = element.querySelector<HTMLSelectElement>('select[aria-label="Membership role"]')!;
    role.value = "member";
    role.dispatchEvent(new Event("change", { bubbles: true }));
    await element.updateComplete;
    const dialog = element.querySelector("openclaw-modal-dialog")!;
    dialog.querySelector("textarea")!.value = "role correction";
    dialog.querySelector("form")!.dispatchEvent(new SubmitEvent("submit", { bubbles: true }));
    await vi.waitFor(() =>
      expect(element.textContent).toContain("updated, but the latest state could not be reloaded"),
    );
    expect(element.querySelector("openclaw-modal-dialog")).toBeNull();
    expect(element.textContent).not.toContain("Organization request failed");
  });

  it("does not render or fetch audit for an ordinary-user deep link", async () => {
    globalThis.history.pushState({}, "", "?tab=audit");
    const fetchImpl = fixtureFetch();
    const element = await mount(fetchImpl);
    expect(element.querySelector("#platformclaw-organization-tab-audit")).toBeNull();
    expect(
      fetchImpl.mock.calls.some(([input]) =>
        (typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url
        ).includes("/audit"),
      ),
    ).toBe(false);
    globalThis.history.pushState({}, "", "/");
  });

  it("lazily fetches audit only after an administrator selects the tab", async () => {
    const base = fixtureFetch({ administrator: true, empty: true });
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return url.includes("/audit") ? json({ items: [] }) : base(input, init);
    });
    const element = await mount(fetchImpl);
    expect(
      fetchImpl.mock.calls.some(([input]) =>
        (typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url
        ).includes("/audit"),
      ),
    ).toBe(false);
    await selectTab(element, "audit");
    await vi.waitFor(() =>
      expect(
        fetchImpl.mock.calls.some(([input]) =>
          (typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url
          ).includes("/audit"),
        ),
      ).toBe(true),
    );
  });
});
