import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { registerOrganizationKnowledgeAnalysis } from "./analysis-gateway.js";

type Handler = Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
function harness() {
  let handler: Handler | undefined;
  const complete = vi.fn(
    async (
      _request: Parameters<OpenClawPluginApi["runtime"]["llm"]["completeWithProviderConfig"]>[0],
    ) => ({
      provider: "company",
      model: "dt-fixture",
      text: JSON.stringify({
        kind: "condition-difference",
        claimIds: ["a", "b"],
        claimRevisions: [
          { id: "a", revision: 1 },
          { id: "b", revision: 1 },
        ],
        summary: "Synthetic condition difference; real DT quality is unverified.",
      }),
    }),
  );
  const register = vi.fn((_method: string, callback: Handler, _options: unknown) => {
    handler = callback;
  });
  const api = {
    config: { agents: { defaults: { model: "company/dt-fixture" } } },
    runtime: { llm: { completeWithProviderConfig: complete } },
    registerGatewayMethod: register,
  } as unknown as OpenClawPluginApi;
  registerOrganizationKnowledgeAnalysis(api);
  const invoke = async (client: unknown, params: unknown) => {
    const respond = vi.fn();
    if (!handler) {
      throw new Error("missing analysis handler");
    }
    await handler({ client, params, respond } as Parameters<Handler>[0]);
    return respond;
  };
  return { complete, register, invoke };
}
const backend = {
  connect: {
    role: "operator",
    scopes: ["operator.admin"],
    client: { mode: "backend" },
    device: { id: "synthetic-service-device" },
  },
  isDeviceTokenAuth: false,
};
const claims = [
  {
    id: "a",
    revision: 1,
    text: "Board-A v1 cache reset repairs startup",
    evidence: ["fixture-a"],
  },
  {
    id: "b",
    revision: 1,
    text: "Board-B v2 cache reset repairs startup",
    evidence: ["fixture-b"],
  },
];

describe("organization knowledge analysis operator Gateway boundary", () => {
  it("uses data-only provider config completion for a paired operator backend", async () => {
    const test = harness();
    const respond = await test.invoke(backend, { claims });
    expect(test.register.mock.calls[0]?.[0]).toBe(
      "platformclaw.organization.knowledge.completePair",
    );
    expect(test.register.mock.calls[0]?.[2]).toEqual({ scope: "operator.admin" });
    expect(respond.mock.calls[0]?.[0]).toBe(true);
    expect(test.complete).toHaveBeenCalledOnce();
    const request = test.complete.mock.calls[0]?.[0];
    expect(request).toBeDefined();
    expect(Object.keys(request ?? {})).toEqual([
      "messages",
      "systemPrompt",
      "model",
      "maxTokens",
      "signal",
      "purpose",
    ]);
    expect(request).not.toHaveProperty("agentId");
    expect(request).not.toHaveProperty("execution");
    expect(request).not.toHaveProperty("tools");
    expect(request?.systemPrompt).toContain("untrusted");
    expect(request?.messages).toHaveLength(1);
    expect(request?.messages[0]?.content).toBe(JSON.stringify({ claims }));
  });

  it.each([
    null,
    { ...backend, connect: { ...backend.connect, device: undefined } },
    { ...backend, connect: { ...backend.connect, scopes: ["operator.read"] } },
    { ...backend, connect: { ...backend.connect, client: { mode: "webchat" } } },
    { ...backend, internal: { syntheticClient: true } },
    { ...backend, connect: { ...backend.connect, role: "node" } },
  ])("rejects untrusted caller %j before completion", async (client) => {
    const test = harness();
    expect((await test.invoke(client, { claims })).mock.calls[0]?.[0]).toBe(false);
    expect(test.complete).not.toHaveBeenCalled();
  });

  it("rejects caller-supplied authority fields and redacts provider errors", async () => {
    const test = harness();
    expect(
      (
        await test.invoke(backend, {
          claims,
          agentId: "employee-private",
          model: "outside/paid",
        })
      ).mock.calls[0]?.[0],
    ).toBe(false);
    expect(test.complete).not.toHaveBeenCalled();
    test.complete.mockRejectedValue(new Error("private endpoint credential diagnostic"));
    const respond = await test.invoke(backend, { claims });
    expect(JSON.stringify(respond.mock.calls)).not.toContain("private endpoint");
  });
});
