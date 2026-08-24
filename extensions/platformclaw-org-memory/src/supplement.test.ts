import { describe, expect, it, vi } from "vitest";
import { createOrganizationMemorySupplement } from "./supplement.js";

describe("PlatformClaw organization memory supplement", () => {
  it("maps bounded virtual results and forwards the pinned agent", async () => {
    const search = vi.fn(async () => [
      {
        path: "organization/team/page-1",
        title: "Release policy",
        scopeName: "Platform",
        snippet: "Two approvals",
        score: 0.9,
        updatedAt: 1_000,
      },
    ]);
    const get = vi.fn(async () => ({
      path: "organization/team/page-1",
      title: "Release policy",
      scopeName: "Platform",
      content: "Two approvals",
      fromLine: 1,
      lineCount: 1,
    }));
    const supplement = createOrganizationMemorySupplement({ search, get }, { warn: vi.fn() });

    await expect(
      supplement.search({ query: "release", maxResults: 5, agentId: "person_one" }),
    ).resolves.toEqual([
      expect.objectContaining({
        corpus: "platformclaw-organization",
        source: "organization",
        path: "organization/team/page-1",
        provenanceLabel: "Platform",
      }),
    ]);
    expect(search).toHaveBeenCalledWith({
      agentId: "person_one",
      query: "release",
      maxResults: 5,
    });
    await expect(
      supplement.get({ lookup: "organization/team/page-1", agentId: "person_one" }),
    ).resolves.toMatchObject({ content: "Two approvals", fromLine: 1, lineCount: 1 });
  });

  it("fails closed for foreign paths and surfaces organization search outages", async () => {
    const warn = vi.fn();
    const supplement = createOrganizationMemorySupplement(
      {
        search: vi.fn(async () => {
          throw new Error("offline");
        }),
        get: vi.fn(),
      },
      { warn },
    );
    await expect(supplement.search({ query: "x", agentId: "person_one" })).rejects.toThrow(
      "offline",
    );
    await expect(
      supplement.get({ lookup: "/srv/private/page", agentId: "person_one" }),
    ).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("offline"));
  });
});
