import { describe, expect, it, vi } from "vitest";
import { resolvePersonalOrganizationMemorySource } from "./organization-memory-personal-source.js";

describe("resolvePersonalOrganizationMemorySource", () => {
  it("uses the Wiki-owned canonical source identity for a reference-free promotion", async () => {
    const request = vi.fn().mockResolvedValue({
      claimId: "claim-recovery",
      revision: 42,
    });
    const first = await resolvePersonalOrganizationMemorySource({
      gateway: { request },
      agentId: "personal-a",
      lookup: "runbooks/recovery.md",
    });
    const second = await resolvePersonalOrganizationMemorySource({
      gateway: { request },
      agentId: "personal-a",
      lookup: "runbooks/recovery.md",
    });
    expect(first).toEqual(second);
    expect(first).toEqual({ claimId: "claim-recovery", revision: 42 });
    expect(request).toHaveBeenCalledWith("wiki.references.resolve", {
      agentId: "personal-a",
      lookup: "runbooks/recovery.md",
    });
  });

  it("preserves the reference-free result shape when submitted text has no Wiki references", async () => {
    const request = vi.fn().mockResolvedValue({
      claimId: "claim-recovery",
      revision: 42,
      referencesTextHash: "a".repeat(64),
      references: [],
    });
    await expect(
      resolvePersonalOrganizationMemorySource({
        gateway: { request },
        agentId: "personal-a",
        lookup: "runbooks/recovery.md",
        proposedText: "Drain jobs before restart.",
      }),
    ).resolves.toEqual({ claimId: "claim-recovery", revision: 42 });
    expect(request).toHaveBeenCalledWith("wiki.references.resolve", {
      agentId: "personal-a",
      lookup: "runbooks/recovery.md",
      proposedText: "Drain jobs before restart.",
    });
  });

  it("delegates proposed-text reference grammar and revision ownership to the Wiki Gateway", async () => {
    const request = vi.fn().mockResolvedValue({
      claimId: "claim-recovery",
      revision: 43,
      referencesTextHash: "a".repeat(64),
      references: [
        {
          start: 12,
          end: 30,
          claimId: "claim-drain",
          revision: 7,
          kind: "personal",
        },
      ],
    });
    await expect(
      resolvePersonalOrganizationMemorySource({
        gateway: { request },
        agentId: "personal-a",
        lookup: "runbooks/recovery.md",
        proposedText: "See [[runbooks/drain]].",
      }),
    ).resolves.toEqual({
      claimId: "claim-recovery",
      revision: 43,
      referencesTextHash: "a".repeat(64),
      references: [
        {
          start: 12,
          end: 30,
          claimId: "claim-drain",
          revision: 7,
          kind: "personal",
          scopeId: undefined,
        },
      ],
    });
    expect(request).toHaveBeenCalledWith("wiki.references.resolve", {
      agentId: "personal-a",
      lookup: "runbooks/recovery.md",
      proposedText: "See [[runbooks/drain]].",
    });
  });

  it.each([
    null,
    { claimId: "", revision: 1 },
    { claimId: "../secret", revision: 1 },
    { claimId: "claim-recovery", revision: 0 },
  ])("fails closed for an invalid canonical source identity", async (source) => {
    await expect(
      resolvePersonalOrganizationMemorySource({
        gateway: { request: vi.fn().mockResolvedValue(source) },
        agentId: "personal-a",
        lookup: "source",
      }),
    ).resolves.toBeNull();
  });

  it("fails closed when proposed-text reference metadata is incomplete", async () => {
    await expect(
      resolvePersonalOrganizationMemorySource({
        gateway: {
          request: vi.fn().mockResolvedValue({
            claimId: "claim-recovery",
            revision: 42,
            references: [],
          }),
        },
        agentId: "personal-a",
        lookup: "source",
        proposedText: "No private references.",
      }),
    ).resolves.toBeNull();
  });
});
