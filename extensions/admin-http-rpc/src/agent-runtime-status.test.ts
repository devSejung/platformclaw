import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { handleAgentRuntimeStatus } from "./agent-runtime-status.js";

describe("PlatformClaw agent runtime status", () => {
  const agentId = "account_name";
  const workspace = path.resolve("agent-workspaces/account_name");

  function callStatus(
    options: {
      workspace?: string;
      loadError?: Error;
      snapshot?: { agentId: string; workspaceDir: string };
    } = {},
  ) {
    const configuredWorkspace = options.workspace ?? workspace;
    const respond = vi.fn();
    const loadError = options.loadError;
    const loadGatewayModelCatalogSnapshot = loadError
      ? vi.fn(async () => {
          throw loadError;
        })
      : vi.fn(async () => options.snapshot ?? { agentId, workspaceDir: configuredWorkspace });
    return {
      respond,
      loadGatewayModelCatalogSnapshot,
      promise: handleAgentRuntimeStatus({
        params: { agentId, workspace },
        respond,
        context: {
          getRuntimeConfig: () => ({
            agents: { list: [{ id: agentId, workspace: configuredWorkspace }] },
          }),
          loadGatewayModelCatalogSnapshot,
        } as never,
      } as never),
    };
  }

  it("reports ready only after the exact prepared runtime owner is published", async () => {
    const result = callStatus();
    await result.promise;

    expect(result.loadGatewayModelCatalogSnapshot).toHaveBeenCalledWith({
      agentId,
      workspaceDir: workspace,
      readOnly: false,
    });
    expect(result.respond).toHaveBeenCalledWith(
      true,
      { ok: true, ready: true, agentId, workspace },
      undefined,
    );
  });

  it("reports unavailable while the prepared runtime owner is still replacing", async () => {
    const result = callStatus({ loadError: new Error("owner replacement pending") });
    await result.promise;

    expect(result.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        message: `agent runtime is not ready: ${agentId}`,
      }),
    );
  });

  it("reports unavailable when the loaded snapshot still belongs to the previous owner", async () => {
    const result = callStatus({
      snapshot: { agentId: "previous_owner", workspaceDir: workspace },
    });
    await result.promise;

    expect(result.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        message: `agent runtime is not ready: ${agentId}`,
      }),
    );
  });

  it("rejects a workspace that is not assigned to the agent", async () => {
    const result = callStatus({ workspace: path.resolve("agent-workspaces/other") });
    await result.promise;

    expect(result.loadGatewayModelCatalogSnapshot).not.toHaveBeenCalled();
    expect(result.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });
});
