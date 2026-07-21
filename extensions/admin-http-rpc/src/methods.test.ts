import { describe, expect, it } from "vitest";
import { isAdminHttpRpcAllowedMethod } from "./methods.js";

describe("admin HTTP RPC method allowlist", () => {
  it("allows the plugin-owned profile seed method", () => {
    expect(isAdminHttpRpcAllowedMethod("platformclaw.profile.seed")).toBe(true);
  });
});
