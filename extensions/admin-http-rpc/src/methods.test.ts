import { describe, expect, it } from "vitest";
import { isAdminHttpRpcAllowedMethod } from "./methods.js";

describe("admin HTTP RPC method allowlist", () => {
  it("allows the PlatformClaw control-plane methods", () => {
    expect(isAdminHttpRpcAllowedMethod("platformclaw.agent.runtimeStatus")).toBe(true);
    expect(isAdminHttpRpcAllowedMethod("platformclaw.profile.seed")).toBe(true);
    expect(isAdminHttpRpcAllowedMethod("platformclaw.profile.status")).toBe(true);
    expect(isAdminHttpRpcAllowedMethod("platformclaw-execution.testConnection")).toBe(true);
    expect(isAdminHttpRpcAllowedMethod("platformclaw-execution.testCandidateConnection")).toBe(
      true,
    );
    expect(isAdminHttpRpcAllowedMethod("platformclaw-execution.changeTarget")).toBe(true);
  });
});
