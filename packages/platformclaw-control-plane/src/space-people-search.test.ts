import { describe, expect, it } from "vitest";
import { BrowserSpaceGateway } from "./browser-gateway-spaces.js";
import { createSpaceTestFixture as fixture } from "./spaces.test-fixtures.js";

const method = "platformclaw.spaces.people";
describe("Space invitation directory search", () => {
  it("matches literal partial accounts and display names, excluding inactive and existing members", async () => {
    const f = await fixture();
    await f.store.upsertPrincipal(
      {
        provider: "ldap",
        subject: "bob",
        accountId: "bob",
        employeeId: "bob",
        displayName: "김보람",
      },
      Date.now(),
    );
    const search = (query: string) =>
      f.proxy.request(f.alice.token, method, { spaceId: f.space.id, query });
    const bob = { userId: f.bob.user.id, accountId: "bob", displayName: "김보람" };
    expect(await search(" BO ")).toEqual([bob]);
    expect(await search("보람")).toEqual([bob]);
    expect(await search("ali")).toEqual([]);
    for (const query of ["%", "_", "\\", "' OR 1=1 --"]) {
      expect(await search(query)).toEqual([]);
    }
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "editor", 1);
    expect(await search("bo")).toEqual([]);
    await f.store.setManagedUserStatus({
      actorUserId: f.alice.user.id,
      targetUserId: f.carol.user.id,
      status: "disabled",
      changedAt: Date.now(),
    });
    expect(await search("car")).toEqual([]);
    await expect(search(" ")).rejects.toThrow("Invalid");
    await expect(search("x".repeat(161))).rejects.toThrow("Invalid");
  });

  it("returns at most twenty deterministic candidates and permits only Space owners", async () => {
    const f = await fixture();
    for (let index = 24; index >= 0; index--) {
      const accountId = `employee-${String(index).padStart(2, "0")}`;
      await f.store.upsertPrincipal(
        {
          provider: "ldap",
          subject: accountId,
          accountId,
          employeeId: accountId,
          displayName: "Team Member",
        },
        Date.now(),
      );
    }
    const result = await f.proxy.request<Array<{ accountId: string }>>(f.alice.token, method, {
      spaceId: f.space.id,
      query: "Team",
    });
    expect(result.map((person) => person.accountId)).toEqual(
      Array.from({ length: 20 }, (_, index) => `employee-${String(index).padStart(2, "0")}`),
    );
    for (const role of [null, "viewer", "editor"] as const) {
      if (role) {
        f.store.spaces.setMember(
          f.alice.user.id,
          f.space.id,
          f.bob.user.id,
          role,
          f.store.spaces.access(f.alice.user.id, f.space.id).revision,
        );
      }
      await expect(
        f.proxy.request(f.bob.token, method, { spaceId: f.space.id, query: "Team" }),
      ).rejects.toThrow("unavailable");
    }
  });

  it("rechecks owner authority after browser identity revalidation", async () => {
    const f = await fixture();
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "owner", 1);
    const access = await f.proxy.resolveAccess(f.alice.token);
    const gateway = new BrowserSpaceGateway(f.service, async () => {
      f.store.spaces.setMember(f.bob.user.id, f.space.id, f.alice.user.id, "editor", 2);
      return access;
    });
    await expect(
      gateway.request(f.alice.token, access, method, { spaceId: f.space.id, query: "car" }),
    ).rejects.toThrow("unavailable");
  });
});
