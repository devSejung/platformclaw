import { Value } from "typebox/value";
import { describe, expect, test } from "vitest";
import { AgentsListResultSchema } from "./agents-models-skills.js";

function agentsListWithRuntime(kind?: string, agent?: string) {
  return {
    defaultId: "main",
    mainKey: "main",
    scope: "per-sender",
    agents: [
      {
        id: "main",
        agentRuntime: {
          id: "acpx",
          ...(kind ? { kind } : {}),
          ...(agent ? { agent } : {}),
          source: "session",
        },
      },
    ],
  };
}

describe("GatewayAgentRuntimeSchema ACP discriminator", () => {
  test("accepts the additive ACP runtime kind and persisted external agent", () => {
    expect(Value.Check(AgentsListResultSchema, agentsListWithRuntime("acp", "claude"))).toBe(true);
  });

  test("keeps agent optional and rejects unknown runtime kinds", () => {
    expect(Value.Check(AgentsListResultSchema, agentsListWithRuntime())).toBe(true);
    expect(Value.Check(AgentsListResultSchema, agentsListWithRuntime("acp"))).toBe(true);
    expect(Value.Check(AgentsListResultSchema, agentsListWithRuntime("embedded", "claude"))).toBe(
      false,
    );
  });

  test("remains closed after adding the ACP agent field", () => {
    const value = agentsListWithRuntime("acp", "codex");
    const agentRuntime = value.agents[0]?.agentRuntime;
    if (!agentRuntime) {
      throw new Error("test fixture must include agent runtime");
    }
    (agentRuntime as Record<string, unknown>).unexpected = "nope";
    expect(Value.Check(AgentsListResultSchema, value)).toBe(false);
  });
});
