import { describe, expect, it } from "vitest";
import { decodeTrustedVisibleAcpInitialization } from "./visible-acp-session-initialization.js";

describe("trusted visible ACP initialization decoder", () => {
  it("accepts the bounded signed/internal runtime identity shape", () => {
    expect(
      decodeTrustedVisibleAcpInitialization({
        logicalAgentId: "claude-worker",
        runtimeAgentId: "claude",
        executionOwnerAgentId: "main",
        runtimeOptions: {
          model: "claude-sonnet-4-6",
          thinking: "high",
          timeoutSeconds: 120,
        },
        modelExplicit: true,
      }),
    ).toEqual({
      logicalAgentId: "claude-worker",
      runtimeAgentId: "claude",
      executionOwnerAgentId: "main",
      runtimeOptions: {
        model: "claude-sonnet-4-6",
        thinking: "high",
        timeoutSeconds: 120,
      },
      modelExplicit: true,
    });
  });

  it("rejects malformed runtime options instead of weakening the trusted boundary", () => {
    expect(
      decodeTrustedVisibleAcpInitialization({
        logicalAgentId: "codex-worker",
        runtimeAgentId: "codex",
        runtimeOptions: { timeoutSeconds: -1 },
      }),
    ).toBeUndefined();
    expect(
      decodeTrustedVisibleAcpInitialization({
        logicalAgentId: "codex-worker",
        runtimeAgentId: "codex",
        modelExplicit: "yes",
      }),
    ).toBeUndefined();
  });
});
