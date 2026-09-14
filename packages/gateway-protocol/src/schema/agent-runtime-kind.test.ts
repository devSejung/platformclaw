import { Value } from "typebox/value";
import { describe, expect, test } from "vitest";
import { AgentsListResultSchema } from "./agents-models-skills.js";

function agentsListWithRuntime(kind?: string) {
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
          source: "session",
        },
      },
    ],
  };
}

describe("GatewayAgentRuntimeSchema ACP discriminator", () => {
  test("accepts the additive ACP runtime kind", () => {
    expect(Value.Check(AgentsListResultSchema, agentsListWithRuntime("acp"))).toBe(true);
  });

  test("rejects unknown runtime kinds while keeping the field optional", () => {
    expect(Value.Check(AgentsListResultSchema, agentsListWithRuntime())).toBe(true);
    expect(Value.Check(AgentsListResultSchema, agentsListWithRuntime("embedded"))).toBe(false);
  });
});
