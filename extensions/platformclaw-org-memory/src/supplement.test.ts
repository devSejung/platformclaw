import { describe, expect, it, vi } from "vitest";
import { createWikiHubCorpusSupplement } from "./supplement.js";

describe("Wiki Hub supplement", () => {
  it("forwards common operations with the prepared scope and passes editor metadata", async () => {
    const scope = { revision: 9, vaultIds: ["one"], personalEnabled: false };
    const wiki = vi.fn(async () => ({ text: "One Wiki, healthy", details: { vaultId: "one" } }));
    const supplement = createWikiHubCorpusSupplement(
      {
        search: async () => [],
        get: async () => ({
          vaultId: "one",
          vaultName: "Spec",
          vaultType: "shared",
          documentId: "doc",
          revision: 7,
          path: "shared/one/doc",
          title: "Spec",
          content: "editable body",
          editMode: "body",
          fromLine: 1,
          lineCount: 1,
          totalLines: 1,
          truncated: false,
        }),
        wiki,
      },
      { warn: vi.fn() },
      () => scope,
      async () => scope,
    );
    await expect(supplement.scope!({ agentId: "owner", runId: "run" })).resolves.toEqual({
      personalWikiEnabled: false,
    });
    await supplement.wiki({ agentId: "owner", runId: "run", operation: "status" });
    expect(wiki).toHaveBeenCalledWith({
      agentId: "owner",
      runId: "run",
      operation: "status",
      turnScope: scope,
    });
    await expect(
      supplement.get({ agentId: "owner", lookup: "shared/one/doc" }),
    ).resolves.toMatchObject({
      revision: 7,
      editMode: "body",
      content: "editable body",
      totalLines: 1,
      truncated: false,
    });
  });
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
    const supplement = createWikiHubCorpusSupplement(
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
      createWikiHubCorpusSupplement(null, { warn: vi.fn() }).get({
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
    const supplement = createWikiHubCorpusSupplement({ search, get }, { warn: vi.fn() });
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

  it("marks an owned Shared read outage so it cannot fall through to Personal", async () => {
    const supplement = createWikiHubCorpusSupplement(
      {
        search: async () => [],
        get: async () => {
          throw new Error("private socket path");
        },
      },
      { warn: vi.fn() },
    );
    await expect(
      supplement.get({ lookup: "shared/project-one/doc-one", agentId: "person_one" }),
    ).rejects.toMatchObject({
      memoryCorpusFailure: expect.objectContaining({ action: expect.any(String) }),
    });
  });

  it("declares default participation and reports missing managed wiring", async () => {
    const supplement = createWikiHubCorpusSupplement(null, { warn: vi.fn() });

    expect(supplement.includeByDefault).toBe(true);
    expect(supplement.status()).toEqual({ available: false, reason: "not-configured" });
    await expect(supplement.search({ query: "release", agentId: "person_one" })).rejects.toThrow(
      "Wiki Hub service is unavailable",
    );
  });

  it("rejects retired Organization results and never reads their paths", async () => {
    const get = vi.fn();
    const supplement = createWikiHubCorpusSupplement(
      { search: async () => [{ vaultType: "managed", path: "organization/team/old" }], get },
      { warn: vi.fn() },
    );
    await expect(supplement.search({ query: "legacy", agentId: "person_one" })).rejects.toThrow(
      "Wiki Hub service is unavailable",
    );
    await expect(
      supplement.get({ lookup: "organization/team/old", agentId: "person_one" }),
    ).resolves.toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it("fails closed for foreign paths and surfaces organization search outages", async () => {
    const warn = vi.fn();
    const supplement = createWikiHubCorpusSupplement(
      {
        search: vi.fn(async () => {
          throw new Error("offline");
        }),
        get: vi.fn(),
      },
      { warn },
    );
    await expect(supplement.search({ query: "x", agentId: "person_one" })).rejects.toThrow(
      "Wiki Hub service is unavailable",
    );
    await expect(
      supplement.get({ lookup: "/srv/private/page", agentId: "person_one" }),
    ).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("offline"));
  });
});
