import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import type { OrganizationScopeResult } from "./organization-api.ts";
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
  refreshFailsAfterMutation?: boolean;
}) {
  let mutationCommitted = false;
  const team = { id: "team-1", kind: "team" as const, name: "Platform", status: "active" as const };
  const group = {
    id: "group-1",
    kind: "group" as const,
    name: "Runtime",
    parentScopeId: team.id,
    status: "active" as const,
  };
  const managed = options?.manager
    ? { canManageMembers: true, canManageStructure: false, canManageLeaders: false }
    : none;
  return vi.fn<typeof fetch>(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/memberships") && options?.membershipConflict) {
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
          : [{ scopeId: group.id, role: options?.manager ? "leader" : "member" }],
        directMembershipsHasMore: false,
        directScopeLineages: options?.empty ? [] : [{ scopeId: group.id, lineage: [team, group] }],
        effectiveScopes: options?.empty
          ? []
          : [
              {
                scope: group,
                source: "direct",
                directRole: options?.manager ? "leader" : "member",
              },
              { scope: team, source: "ancestor" },
            ],
        effectiveScopesHasMore: false,
        primaryScope: options?.empty ? null : group,
        primaryScopeLineage: options?.empty ? [] : [team, group],
      });
    }
    if (url.includes("/scopes?")) {
      return json({
        items: options?.empty
          ? []
          : [
              scope(team.id, "team", team.name, [team], none),
              scope(group.id, "group", group.name, [team, group], managed),
            ],
        hasMore: false,
      });
    }
    if (url.includes("/management/scopes/group-1?")) {
      return json({
        scope: group,
        members: [
          {
            user: {
              id: "user-1",
              accountId: "person.one",
              displayName: "Person",
              status: "active",
            },
            role: options?.manager ? "leader" : "member",
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
    const fetchImpl = fixtureFetch({ manager: true, membershipConflict: true });
    const element = await mount(fetchImpl);
    await selectTab(element, "management");
    await vi.waitFor(() => expect(element.textContent).toContain("person.one"));
    const role = element.querySelector<HTMLSelectElement>('select[aria-label="Membership role"]')!;
    role.value = "member";
    role.dispatchEvent(new Event("change", { bubbles: true }));
    await element.updateComplete;
    const dialog = element.querySelector("openclaw-modal-dialog")!;
    dialog.querySelector("textarea")!.value = "role correction";
    dialog.querySelector("form")!.dispatchEvent(new SubmitEvent("submit", { bubbles: true }));
    await vi.waitFor(() => expect(element.textContent).toContain("The roster changed"));
    const modalError = element
      .querySelector("openclaw-modal-dialog")
      ?.querySelector<HTMLElement>('[role="alert"]');
    expect(modalError?.textContent).toContain("The roster changed");
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
});
