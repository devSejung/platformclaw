import { describe, expect, it, vi } from "vitest";
import { createOrganizationMemorySupplement } from "./supplement.js";

describe("PlatformClaw organization memory supplement", () => {
  it("forwards an explicit name without a captured scope and preserves safe disambiguation", async () => {
    const failure = {
      error: "Multiple accessible Vaults have that exact name",
      action: "Ask the user to select a Vault",
      vaultChoices: [{ vaultId: "one", vaultName: "PHY", vaultType: "shared" }],
    };
    const search = vi.fn(async () => {
      throw Object.assign(new Error(failure.error), { memoryCorpusFailure: failure });
    });
    const getTurnScope = vi.fn(() => {
      throw new Error("must not capture");
    });
    const supplement = createOrganizationMemorySupplement(
      { search, get: vi.fn() },
      { warn: vi.fn() },
      getTurnScope,
    );
    await expect(
      supplement.search({
        query: "training",
        agentId: "person_one",
        vaultName: "PHY",
        runId: "run",
      }),
    ).rejects.toMatchObject({ memoryCorpusFailure: failure });
    expect(search).toHaveBeenCalledWith({
      query: "training",
      agentId: "person_one",
      vaultName: "PHY",
    });
    expect(getTurnScope).not.toHaveBeenCalled();
    await expect(
      createOrganizationMemorySupplement(null, { warn: vi.fn() }).get({
        lookup: "concepts/private.md",
        agentId: "person_one",
      }),
    ).resolves.toBeNull();
  });
  it("forwards explicit vault scope and reads shared documents through the same client", async () => {
    const identity = {
      vaultId: "project-one",
      vaultName: "Project One",
      vaultType: "shared",
      documentId: "doc-one",
      revision: 7,
      indexStatus: "failed",
      indexError: "compile interrupted",
      nextRetryAt: 12345,
    };
    const search = vi.fn(async () => [
      {
        ...identity,
        path: "shared/project-one/doc-one",
        title: "Spec",
        snippet: "training",
        score: 1,
      },
    ]);
    const get = vi.fn(async () => ({
      ...identity,
      path: "shared/project-one/doc-one",
      title: "Spec",
      content: "training",
      fromLine: 1,
      lineCount: 1,
    }));
    const supplement = createOrganizationMemorySupplement({ search, get }, { warn: vi.fn() });
    await expect(
      supplement.search({ query: "training", agentId: "person_one", vaultId: "project-one" }),
    ).resolves.toEqual([expect.objectContaining(identity)]);
    expect(search).toHaveBeenCalledWith({
      query: "training",
      agentId: "person_one",
      vaultId: "project-one",
    });
    await expect(
      supplement.get({ lookup: "shared/project-one/doc-one", agentId: "person_one" }),
    ).resolves.toMatchObject({
      vaultId: identity.vaultId,
      revision: identity.revision,
      content: "training",
    });
  });

  it("declares default participation and reports missing managed wiring", async () => {
    const supplement = createOrganizationMemorySupplement(null, { warn: vi.fn() });

    expect(supplement.includeByDefault).toBe(true);
    expect(supplement.status()).toEqual({ available: false, reason: "not-configured" });
    await expect(supplement.search({ query: "release", agentId: "person_one" })).rejects.toThrow(
      "Knowledge Vault service is unavailable",
    );
  });

  it("maps bounded virtual results and forwards the pinned agent", async () => {
    const search = vi.fn(async () => [
      {
        path: "organization/team/page-1",
        title: "Release policy",
        vaultId: "managed:team:platform",
        vaultName: "Platform",
        vaultType: "managed",
        documentId: "page-1",
        revision: 1,
        snippet: "Two approvals",
        score: 0.9,
        updatedAt: 1_000,
      },
    ]);
    const get = vi.fn(async () => ({
      path: "organization/team/page-1",
      title: "Release policy",
      vaultId: "managed:team:platform",
      vaultName: "Platform",
      vaultType: "managed",
      documentId: "page-1",
      revision: 1,
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
      "Knowledge Vault service is unavailable",
    );
    await expect(
      supplement.get({ lookup: "/srv/private/page", agentId: "person_one" }),
    ).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("offline"));
  });
});
