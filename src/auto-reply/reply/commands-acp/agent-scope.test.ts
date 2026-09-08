import { describe, expect, it } from "vitest";
import { acpSessionBelongsToAgentScope } from "./agent-scope.js";

describe("ACP attributed agent scope", () => {
  it("accepts the persisted execution owner", () => {
    expect(
      acpSessionBelongsToAgentScope({
        agentScope: "Person_One",
        acp: {
          backend: "acpx",
          agent: "claude",
          executionOwnerAgentId: "person_one",
          runtimeSessionName: "runtime-1",
          mode: "persistent",
          state: "idle",
          lastActivityAt: 1,
        },
      }),
    ).toBe(true);
  });

  it("accepts ACP lineage spawned by another session of the personal agent", () => {
    expect(
      acpSessionBelongsToAgentScope({
        agentScope: "person_one",
        entry: {
          sessionId: "session-owned",
          spawnedBy: "agent:person_one:dashboard:other",
          updatedAt: 1,
        },
      }),
    ).toBe(true);
  });

  it("rejects sessions owned by another personal agent or without ownership facts", () => {
    expect(
      acpSessionBelongsToAgentScope({
        agentScope: "person_one",
        entry: {
          sessionId: "session-foreign",
          spawnedBy: "agent:person_two:dashboard:main",
          updatedAt: 1,
        },
      }),
    ).toBe(false);
    expect(acpSessionBelongsToAgentScope({ agentScope: "person_one" })).toBe(false);
  });
});
