/* @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { wikiHubSnapshot } from "../test-helpers/platformclaw-wiki-hub-fixture.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import {
  button,
  mount,
  rpc,
  setupVaultTests,
  snapshot,
  submit,
} from "./memory-vaults.test-support.ts";
setupVaultTests();
describe("Wiki Hub access", () => {
  it("grants a person or organization the selected role through bounded directory search", async () => {
    const request = vi.fn(async (method: string, params?: { kind?: string }) =>
      method === `${rpc}targets.search`
        ? {
            items:
              params?.kind === "organization"
                ? [{ id: "team-1", label: "PHY Team", detail: "Platform / PHY" }]
                : [{ id: "user-2", accountId: "engineer", label: "Engineer", detail: "engineer" }],
            hasMore: false,
          }
        : snapshot(),
    );
    const element = mount(request);
    await waitForFast(() => expect(element.textContent).toContain("PHY Spec"));
    button(element, "Members and permissions").click();
    await waitForFast(() =>
      expect(element.querySelector("platformclaw-vault-access form")).not.toBeNull(),
    );
    const access = element.querySelector("platformclaw-vault-access")!;
    const selects = access.querySelectorAll("select");
    selects[1]!.value = "editor";
    selects[1]!.dispatchEvent(new Event("change", { bubbles: true }));
    submit(access.querySelector("form")!);
    await waitForFast(() => expect(access.textContent).toContain("Engineer"));
    button(element, "Grant selected role").click();
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith(`${rpc}member.set`, {
        vaultId: "vault-1",
        accountId: "engineer",
        role: "editor",
      }),
    );
    await waitForFast(() => expect(selects[0]!.disabled).toBe(false));
    selects[0]!.value = "organization";
    selects[0]!.dispatchEvent(new Event("change", { bubbles: true }));
    await element.updateComplete;
    submit(access.querySelector("form")!);
    await waitForFast(() => expect(access.textContent).toContain("PHY Team"));
    button(element, "Grant selected role").click();
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith(`${rpc}grant.set`, {
        vaultId: "vault-1",
        scopeId: "team-1",
        role: "editor",
      }),
    );
  });
  it("confirms removals before mutating member or organization access", async () => {
    const current = snapshot();
    current.selected!.grants = [
      { scopeId: "team-1", scopeName: "PHY Team", scopeKind: "team", role: "reader" },
    ];
    const request = vi.fn().mockResolvedValue(current);
    const element = mount(request);
    await waitForFast(() => expect(element.textContent).toContain("PHY Spec"));
    button(element, "Members and permissions").click();
    await waitForFast(() =>
      expect(element.querySelector("platformclaw-vault-access")).not.toBeNull(),
    );
    const access = element.querySelector<HTMLElement>("platformclaw-vault-access")!;
    const removal = [...access.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent?.trim() === "Remove grant",
    );
    removal!.click();
    await waitForFast(() =>
      expect(access.textContent).toContain("Remove Reader User's direct access"),
    );
    expect(request.mock.calls.some(([method]) => method === `${rpc}member.remove`)).toBe(false);
    expect(button(access, "Confirm change").classList.contains("danger")).toBe(true);
    button(access, "Confirm change").click();
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith(`${rpc}member.remove`, {
        vaultId: "vault-1",
        userId: "u-reader",
      }),
    );
    element.remove();

    const organizationRequest = vi.fn().mockResolvedValue(current);
    const organizationElement = mount(organizationRequest);
    await waitForFast(() => expect(organizationElement.textContent).toContain("PHY Spec"));
    button(organizationElement, "Members and permissions").click();
    await waitForFast(() =>
      expect(organizationElement.querySelector("platformclaw-vault-access")).not.toBeNull(),
    );
    const organizationAccess = organizationElement.querySelector<HTMLElement>(
      "platformclaw-vault-access",
    )!;
    const nextRemovals = [
      ...organizationAccess.querySelectorAll<HTMLButtonElement>("button"),
    ].filter((candidate) => candidate.textContent?.trim() === "Remove grant");
    nextRemovals[1]!.click();
    await waitForFast(() =>
      expect(organizationAccess.textContent).toContain(
        "Remove only the PHY Team organization grant",
      ),
    );
    expect(organizationRequest.mock.calls.some(([method]) => method === `${rpc}grant.remove`)).toBe(
      false,
    );
    expect(button(organizationAccess, "Confirm change").classList.contains("danger")).toBe(true);
    button(organizationAccess, "Confirm change").click();
    await waitForFast(() =>
      expect(organizationRequest).toHaveBeenCalledWith(`${rpc}grant.remove`, {
        vaultId: "vault-1",
        scopeId: "team-1",
      }),
    );
  });
  it("requires explicit impact confirmation before granting Owner to an organization", async () => {
    const request = vi.fn(async (method: string) =>
      method === `${rpc}targets.search`
        ? { items: [{ id: "team-1", label: "PHY Team", detail: "Platform / PHY" }], hasMore: false }
        : snapshot(),
    );
    const element = mount(request);
    await waitForFast(() => expect(element.textContent).toContain("PHY Spec"));
    button(element, "Members and permissions").click();
    await waitForFast(() =>
      expect(element.querySelector("platformclaw-vault-access form")).not.toBeNull(),
    );
    const access = element.querySelector<HTMLElement>("platformclaw-vault-access")!;
    const selects = access.querySelectorAll("select");
    selects[0]!.value = "organization";
    selects[0]!.dispatchEvent(new Event("change", { bubbles: true }));
    selects[1]!.value = "owner";
    selects[1]!.dispatchEvent(new Event("change", { bubbles: true }));
    await element.updateComplete;
    submit(access.querySelector("form")!);
    await waitForFast(() => expect(access.textContent).toContain("PHY Team"));
    button(access, "Grant selected role").click();
    await waitForFast(() =>
      expect(access.textContent).toContain("Only direct members of that exact organization"),
    );
    expect(request.mock.calls.some(([method]) => method === `${rpc}grant.set`)).toBe(false);
    expect(button(access, "Confirm change").classList.contains("primary")).toBe(true);
    expect(button(access, "Confirm change").classList.contains("danger")).toBe(false);
    button(access, "Confirm change").click();
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith(`${rpc}grant.set`, {
        vaultId: "vault-1",
        scopeId: "team-1",
        role: "owner",
      }),
    );
  });
  it("shows owner approvals and own requests with explicit outcomes", async () => {
    let current = wikiHubSnapshot({ pending: true });
    const request = vi.fn(async (method: string) => {
      if (method === `${rpc}access.decide`) {
        current = { ...current, pendingRequests: [] };
      }
      return current;
    });
    const element = mount(request);
    await waitForFast(() =>
      expect(element.querySelector("#vault-catalog-tab-requests")).not.toBeNull(),
    );
    element
      .querySelector("#vault-catalog-tab-requests")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    await element.updateComplete;
    button(element, "Approve").click();
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith(`${rpc}access.decide`, {
        requestId: "request-review",
        decision: "approve",
      }),
    );
    await waitForFast(() =>
      expect(element.textContent).toContain("No requests awaiting your approval"),
    );
    button(element, "Cancel request").click();
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith(`${rpc}access.cancel`, { requestId: "request-own" }),
    );
  });
  it("recovers an orphan Owner only after explicit confirmation without reading its documents", async () => {
    let current = wikiHubSnapshot();
    current.vaults = current.vaults.map((vault) =>
      vault.id === "vault-lpddr" ? { ...vault, canRecoverOwner: true } : vault,
    );
    const request = vi.fn(async (method: string) => {
      if (method === `${rpc}targets.search`) {
        return {
          items: [
            { id: "new-owner", accountId: "new.owner", label: "New Owner", detail: "new.owner" },
          ],
          hasMore: false,
        };
      }
      if (method === `${rpc}owner.recover`) {
        current = {
          ...current,
          vaults: current.vaults.map((vault) => ({ ...vault, canRecoverOwner: false })),
        };
      }
      return current;
    });
    const element = mount(request);
    await waitForFast(() =>
      expect(element.querySelector("#vault-catalog-tab-discover")).not.toBeNull(),
    );
    element
      .querySelector("#vault-catalog-tab-discover")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    await element.updateComplete;
    button(element, "Assign a new Owner").click();
    await waitForFast(() =>
      expect(element.querySelector("platformclaw-vault-recovery form")).not.toBeNull(),
    );
    submit(element.querySelector<HTMLFormElement>("platformclaw-vault-recovery form")!);
    await waitForFast(() =>
      expect(element.querySelector("platformclaw-vault-recovery")?.textContent).toContain(
        "New Owner",
      ),
    );
    button(
      element.querySelector<HTMLElement>("platformclaw-vault-recovery")!,
      "Assign a new Owner",
    ).click();
    await waitForFast(() => expect(button(element, "Confirm new Owner")).toBeDefined());
    expect(request.mock.calls.some(([method]) => method === `${rpc}owner.recover`)).toBe(false);
    const staleConfirmation = button(element, "Confirm new Owner");
    element.connected = false;
    await waitForFast(() =>
      expect(element.querySelector("platformclaw-vault-recovery")).toBeNull(),
    );
    staleConfirmation.click();
    expect(request.mock.calls.some(([method]) => method === `${rpc}owner.recover`)).toBe(false);
    element.connected = true;
    await waitForFast(() => expect(button(element, "Assign a new Owner").disabled).toBe(false));
    button(element, "Assign a new Owner").click();
    await waitForFast(() =>
      expect(element.querySelector("platformclaw-vault-recovery form")).not.toBeNull(),
    );
    submit(element.querySelector<HTMLFormElement>("platformclaw-vault-recovery form")!);
    await waitForFast(() =>
      expect(element.querySelector("platformclaw-vault-recovery")?.textContent).toContain(
        "New Owner",
      ),
    );
    button(
      element.querySelector<HTMLElement>("platformclaw-vault-recovery")!,
      "Assign a new Owner",
    ).click();
    await waitForFast(() => expect(button(element, "Confirm new Owner")).toBeDefined());
    button(element, "Confirm new Owner").click();
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith(`${rpc}owner.recover`, {
        vaultId: "vault-lpddr",
        accountId: "new.owner",
      }),
    );
    await waitForFast(() =>
      expect(element.querySelector("platformclaw-vault-recovery")).toBeNull(),
    );
    expect(element.textContent).toContain("The new Owner can now manage this vault");
    expect(request.mock.calls.some(([method]) => method === `${rpc}document.get`)).toBe(false);
    expect(element.querySelector('[data-vault-card="vault-lpddr"] wa-switch')).toBeNull();
  });
});
