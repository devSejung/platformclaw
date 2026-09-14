import { describe, expect, it } from "vitest";
import {
  resolveAgentRunSessionCreation,
  resolveOperatorSessionCreation,
} from "./session-creation-provenance.js";

describe("agent run session creation provenance", () => {
  it("uses a proven Gateway profile id", () => {
    expect(
      resolveAgentRunSessionCreation({
        authenticatedUserProfile: { profileId: "profile-ada" },
      }),
    ).toEqual({ via: "run", actor: { type: "human", id: "profile-ada" } });
  });

  it("does not infer an actor for a profile-less wire client", () => {
    expect(resolveAgentRunSessionCreation({})).toEqual({ via: "run" });
  });

  it("recovers visible ACP initialization only from trusted agent-runtime identity", () => {
    expect(
      resolveOperatorSessionCreation(
        {
          internal: {
            agentRuntimeIdentity: {
              kind: "agentRuntime",
              agentId: "main",
              sessionKey: "agent:main:main",
              sessionSpawnContext: {
                inheritedToolPolicy: { version: 1, allow: ["read"], deny: ["exec"] },
                completionOwnerSessionKey: "agent:main:main",
                acpInitialization: {
                  logicalAgentId: "codex-worker",
                  runtimeAgentId: "codex",
                  executionOwnerAgentId: "main",
                  runtimeOptions: { timeoutSeconds: 90 },
                },
              },
            },
          },
        },
        { allowTrustedHint: true },
      ),
    ).toEqual({
      via: "spawn",
      actor: { type: "agent", id: "agent:main:main" },
      completionOwnerSessionKey: "agent:main:main",
      inheritedToolPolicy: { version: 1, allow: ["read"], deny: ["exec"] },
      acpInitialization: {
        logicalAgentId: "codex-worker",
        runtimeAgentId: "codex",
        executionOwnerAgentId: "main",
        runtimeOptions: { timeoutSeconds: 90 },
      },
    });
  });
});
