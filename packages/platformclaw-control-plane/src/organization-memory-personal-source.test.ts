import { describe, expect, it, vi } from "vitest";
import { resolvePersonalOrganizationMemorySource } from "./organization-memory-personal-source.js";

describe("resolvePersonalOrganizationMemorySource", () => {
  it("returns a canonical stable revision for a complete native Wiki page", async () => {
    const request = vi.fn().mockResolvedValue({
      corpus: "wiki",
      id: "claim-recovery",
      path: "runbooks/recovery.md",
      content: "# Recovery\nDrain jobs.",
      totalLines: 2,
      truncated: false,
      updatedAt: 123,
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
    expect(first).toMatchObject({ claimId: "claim-recovery" });
    expect(first?.revision).toBeGreaterThan(0);
    expect(request).toHaveBeenCalledWith("wiki.get", {
      agentId: "personal-a",
      lookup: "runbooks/recovery.md",
      fromLine: 1,
      lineCount: 10_000,
    });
  });

  it.each([
    null,
    { corpus: "memory", path: "MEMORY.md", content: "raw" },
    { corpus: "wiki", path: "large.md", content: "partial", truncated: true },
    { corpus: "wiki", path: "C:\\Users\\employee\\secret.md", content: "secret" },
  ])("fails closed for a non-claim or incomplete source", async (page) => {
    await expect(
      resolvePersonalOrganizationMemorySource({
        gateway: { request: vi.fn().mockResolvedValue(page) },
        agentId: "personal-a",
        lookup: "source",
      }),
    ).resolves.toBeNull();
  });
});
