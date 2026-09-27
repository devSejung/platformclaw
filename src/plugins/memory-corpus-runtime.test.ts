import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getMemoryCorpusSupplementResult,
  searchMemoryCorpusSupplements,
} from "./memory-corpus-runtime.js";
import { clearMemoryPluginState, registerMemoryCorpusSupplement } from "./memory-state.js";

afterEach(() => clearMemoryPluginState());

describe("memory corpus model-facing boundaries", () => {
  it("stops exact lookup after an owner-approved denial instead of substituting another owner", async () => {
    const substitute = vi.fn(async () => ({
      corpus: "other",
      path: "shared/a/doc",
      content: "wrong document",
      fromLine: 1,
      lineCount: 1,
    }));
    registerMemoryCorpusSupplement("owner", {
      includeByDefault: true,
      search: async () => [],
      get: async () => {
        throw Object.assign(new Error("internal ACL"), {
          memoryCorpusFailure: { error: "Access revoked", action: "Request access" },
        });
      },
    });
    registerMemoryCorpusSupplement("other", {
      includeByDefault: true,
      search: async () => [],
      get: substitute,
    });
    const status = vi.fn();
    expect(
      await getMemoryCorpusSupplementResult({
        lookup: "shared/a/doc",
        failurePolicy: "continue",
        onSupplementStatus: status,
      }),
    ).toBeNull();
    expect(substitute).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith("owner", "failed", {
      error: "Access revoked",
      action: "Request access",
    });
  });
  it("bounds only explicitly owner-approved errors and never exposes arbitrary exceptions", async () => {
    const onSupplementStatus = vi.fn();
    registerMemoryCorpusSupplement("private", {
      includeByDefault: true,
      get: async () => null,
      search: async () => {
        throw new Error("SELECT secrets FROM private_db at internal.example");
      },
    });
    registerMemoryCorpusSupplement("safe", {
      includeByDefault: true,
      get: async () => null,
      search: async () => {
        throw Object.assign(new Error("internal stack must not escape"), {
          memoryCorpusFailure: {
            error: "e".repeat(900),
            action: "a".repeat(900),
            code: "vault-name-ambiguous",
            vaultChoices: Array.from({ length: 8 }, (_, i) => ({
              vaultId: `vault-${i}`,
              vaultName: "n".repeat(900),
              vaultType: "shared",
              privateField: "secret",
            })),
          },
        });
      },
    });
    expect(await searchMemoryCorpusSupplements({ query: "x", onSupplementStatus })).toEqual([]);
    expect(onSupplementStatus).toHaveBeenCalledWith("private", "failed", undefined);
    expect(onSupplementStatus).toHaveBeenCalledWith("safe", "failed", {
      error: "e".repeat(300),
      action: "a".repeat(300),
      code: "vault-name-ambiguous",
      vaultChoices: Array.from({ length: 5 }, (_, i) => ({
        vaultId: `vault-${i}`,
        vaultName: "n".repeat(240),
        vaultType: "shared",
      })),
    });
    expect(JSON.stringify(onSupplementStatus.mock.calls)).not.toMatch(
      /secrets|private_db|internal\.example|privateField/u,
    );
  });

  it("enforces exact normalized names and rejects Personal hits from an older ignoring provider", async () => {
    const base = { corpus: "test", score: 1, snippet: "training", vaultName: "DDRPHY" };
    registerMemoryCorpusSupplement("older", {
      includeByDefault: true,
      get: async () => null,
      search: async () => [
        { ...base, vaultId: "a", vaultType: "shared", path: "shared/a/doc" },
        {
          ...base,
          vaultId: "b",
          vaultType: "managed",
          vaultName: "DDRPHY Other",
          path: "organization/team/doc",
        },
        { ...base, vaultId: "personal:main", vaultType: "personal", path: "MEMORY.md" },
      ],
    });
    expect(
      await searchMemoryCorpusSupplements({ query: "training", vaultName: " ddrphy " }),
    ).toEqual([expect.objectContaining({ vaultId: "a" })]);
  });
});
