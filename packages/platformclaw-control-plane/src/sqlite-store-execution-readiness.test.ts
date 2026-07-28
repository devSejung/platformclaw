import { describe, expect, it } from "vitest";
import { hasCompleteAssignedVmExecutionFields } from "./sqlite-store-execution-readiness.js";

const HOST_KEY = {
  host_key_algorithm: "ssh-ed25519",
  host_key_public_key: "AAAA-test",
  host_key_fingerprint: "SHA256:test",
};

describe("assigned VM execution readiness", () => {
  it("requires a non-root canonical home for executable targets", () => {
    expect(
      hasCompleteAssignedVmExecutionFields(
        { ...HOST_KEY, remote_home_dir: "/", remote_workspace_dir: "/.platformclaw/workspace" },
        true,
      ),
    ).toBe(false);
    expect(
      hasCompleteAssignedVmExecutionFields(
        {
          ...HOST_KEY,
          remote_home_dir: "/users/person.one",
          remote_workspace_dir: "/users/person.one/.platformclaw/workspace",
        },
        true,
      ),
    ).toBe(true);
  });
});
