import { describe, expect, it } from "vitest";
import { setupBrowserGatewayProxyTest as setup } from "./browser-gateway-proxy.test-harness.js";

function cursor(id: string, resolvedAtMs: number): string {
  return Buffer.from(JSON.stringify({ v: 1, resolvedAtMs, id }), "utf8").toString("base64url");
}

function approval(agentId: string, id = `approval-${agentId}`, resolvedAtMs = 2_000) {
  return {
    id,
    urlPath: `/private/control-ui/approve/${id}`,
    createdAtMs: 1_000,
    expiresAtMs: 1_500,
    resolvedAtMs,
    status: "denied",
    decision: "deny",
    reason: "user",
    presentation: {
      kind: "exec",
      commandText: "printf approved",
      commandPreview: "private preview",
      warningText: "private warning",
      host: "private-host",
      nodeId: "private-node",
      agentId,
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    },
    source: { agentId, sessionKey: `agent:${agentId}:main` },
    resolver: { kind: "device", id: "private-device-id" },
  };
}

function alternateApproval(agentId: string, kind: "plugin" | "system-agent") {
  const common = approval(agentId, `${kind}-${agentId}`);
  return {
    ...common,
    presentation:
      kind === "plugin"
        ? {
            kind,
            title: "Plugin request",
            description: "Approve the plugin request.",
            detail: "private detail",
            severity: "warning",
            pluginId: "private-plugin",
            toolName: "private-tool",
            agentId,
            allowedDecisions: ["allow-once", "deny"],
          }
        : {
            kind,
            title: "System request",
            description: "Approve the system request.",
            proposalHash: "a".repeat(64),
            agentId,
            allowedDecisions: ["allow-once", "deny"],
          },
  };
}

describe("BrowserGatewayProxy personal approval history", () => {
  it("pins the source Agent and removes optional infrastructure attribution", async () => {
    const { binding, proxy, request, token } = await setup();
    request.mockResolvedValueOnce({ items: [approval(binding.agentId)] });

    await expect(proxy.request(token, "approval.history", { limit: 50 })).resolves.toEqual({
      items: [
        {
          id: `approval-${binding.agentId}`,
          urlPath: `/approve/approval-${binding.agentId}`,
          createdAtMs: 1_000,
          expiresAtMs: 1_500,
          resolvedAtMs: 2_000,
          status: "denied",
          decision: "deny",
          reason: "user",
          presentation: {
            kind: "exec",
            commandText: "printf approved",
            allowedDecisions: ["allow-once", "allow-always", "deny"],
          },
          source: { agentId: binding.agentId },
          resolver: { kind: "device" },
        },
      ],
    });
    expect(request).toHaveBeenCalledWith("approval.history", {
      agentId: binding.agentId,
      limit: 50,
    });
  });

  it("preserves bounded kind pagination with a matching owned cursor", async () => {
    const { binding, proxy, request, token } = await setup();
    const item = approval(binding.agentId, "approval-page-1", 3_000);
    const nextCursor = cursor(item.id, item.resolvedAtMs);
    request.mockResolvedValueOnce({ items: [item], nextCursor });

    await expect(
      proxy.request(token, "approval.history", { kind: "exec", limit: 1 }),
    ).resolves.toMatchObject({ nextCursor });
    expect(request).toHaveBeenCalledWith("approval.history", {
      agentId: binding.agentId,
      kind: "exec",
      limit: 1,
    });
  });

  it("keeps all presentation kinds valid while stripping their optional identifiers", async () => {
    const { binding, proxy, request, token } = await setup();
    request.mockResolvedValueOnce({
      items: [
        alternateApproval(binding.agentId, "plugin"),
        alternateApproval(binding.agentId, "system-agent"),
      ],
    });

    const result = await proxy.request<{ items: Array<{ presentation: unknown }> }>(
      token,
      "approval.history",
      { limit: 2 },
    );
    expect(result.items.map((item) => item.presentation)).toEqual([
      {
        kind: "plugin",
        title: "Plugin request",
        description: "Approve the plugin request.",
        severity: "warning",
        allowedDecisions: ["allow-once", "deny"],
      },
      {
        kind: "system-agent",
        title: "System request",
        description: "Approve the system request.",
        proposalHash: "a".repeat(64),
        allowedDecisions: ["allow-once", "deny"],
      },
    ]);
  });

  it("rejects foreign Agent and malformed pagination before dispatch", async () => {
    const { proxy, request, token } = await setup();

    await expect(
      proxy.request(token, "approval.history", { agentId: "other", limit: 50 }),
    ).rejects.toMatchObject({ code: "cross-agent-denied" });
    await expect(
      proxy.request(token, "approval.history", { cursor: "not-a-cursor", limit: 50 }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    await expect(
      proxy.request(token, "approval.history", { kind: "unknown", limit: 50 }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    expect(request).not.toHaveBeenCalled();
  });

  it("fails closed on foreign rows and mismatched upstream cursors", async () => {
    const { binding, proxy, request, token } = await setup();
    request
      .mockResolvedValueOnce({ items: [approval("other")] })
      .mockResolvedValueOnce({
        items: [approval(binding.agentId, "owned", 4_000)],
        nextCursor: cursor("foreign", 4_000),
      })
      .mockResolvedValueOnce({
        items: [
          {
            ...approval(binding.agentId, "mismatched-presentation"),
            presentation: { ...approval(binding.agentId).presentation, agentId: "other" },
          },
        ],
      });

    await expect(proxy.request(token, "approval.history", { limit: 50 })).rejects.toMatchObject({
      code: "upstream-result-denied",
    });
    await expect(proxy.request(token, "approval.history", { limit: 50 })).rejects.toMatchObject({
      code: "upstream-result-denied",
    });
    await expect(proxy.request(token, "approval.history", { limit: 50 })).rejects.toMatchObject({
      code: "upstream-result-denied",
    });
  });
});
