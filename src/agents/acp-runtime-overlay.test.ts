import { describe, expect, test } from "vitest";
import { applyAcpRuntimeOverlay, type AgentRuntimeMetadata } from "./acp-runtime-overlay.js";

const configuredRuntime = {
  id: "codex",
  source: "model",
} satisfies AgentRuntimeMetadata;

describe("applyAcpRuntimeOverlay", () => {
  test("projects persisted ACP backend and harness metadata for a dashboard session", () => {
    expect(
      applyAcpRuntimeOverlay(
        configuredRuntime,
        "agent:main:dashboard:visible-child",
        true,
        "custom-acp",
        "claude",
      ),
    ).toEqual({
      id: "custom-acp",
      kind: "acp",
      agent: "claude",
      source: "session",
    });
  });

  test("preserves the legacy source label for an ACP-keyed session with metadata", () => {
    expect(
      applyAcpRuntimeOverlay(
        configuredRuntime,
        "agent:claude:acp:11111111-1111-4111-8111-111111111111",
        true,
        "acpx",
        "claude",
      ),
    ).toEqual({
      id: "acpx",
      kind: "acp",
      agent: "claude",
      source: "session-key",
    });
  });

  test("does not infer ACP runtime ownership from an ACP-shaped key", () => {
    expect(
      applyAcpRuntimeOverlay(
        configuredRuntime,
        "agent:claude:acp:11111111-1111-4111-8111-111111111111",
        false,
        "acpx",
        "claude",
      ),
    ).toBe(configuredRuntime);
  });
});
