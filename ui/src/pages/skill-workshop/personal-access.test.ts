import { describe, expect, it, vi } from "vitest";
import { SkillWorkshopPersonalAccess } from "./personal-access.ts";
import type { SkillWorkshopPageContext } from "./source-scope.ts";

describe("SkillWorkshopPersonalAccess", () => {
  it("does not retry a failed status probe until reset", async () => {
    const request = vi.fn(async () => {
      throw new Error("offline");
    });
    const context = {
      gateway: { snapshot: { client: { request } } },
    } as unknown as SkillWorkshopPageContext;
    const access = new SkillWorkshopPersonalAccess();
    const onError = vi.fn();
    const options = {
      context,
      loadServerProposals: vi.fn(async () => undefined),
      onError,
      onUpdate: vi.fn(),
    };

    await access.load(options);
    await access.load(options);
    expect(request).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();

    access.reset();
    await access.load(options);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
