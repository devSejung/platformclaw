import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PersonalAgentProvisioningRequest } from "./browser-auth-service.js";
import { GatewayAdminRpcError, type GatewayAdminRpc } from "./gateway-admin-rpc-client.js";
import { GatewayPersonalAgentProvisioner } from "./personal-agent-provisioner.js";

function request(
  overrides: Partial<PersonalAgentProvisioningRequest> = {},
): PersonalAgentProvisioningRequest {
  return {
    user: {
      id: "user-1",
      accountId: "account.name",
      employeeId: "employee-1",
      status: "active",
      globalRole: "member",
      groups: [],
      createdAt: 1,
      updatedAt: 1,
    },
    binding: {
      id: "binding-1",
      kind: "personal",
      userId: "user-1",
      agentId: "account_name",
      state: "provisioning",
      createdAt: 1,
      updatedAt: 1,
    },
    profile: {
      employeeId: "employee-1",
      accountId: "account.name",
      subject: "account.name",
      groups: [],
      attributes: {},
    },
    createdBinding: true,
    ...overrides,
  };
}

function createRpc(
  handler: (method: string, params: unknown) => unknown | Promise<unknown>,
): GatewayAdminRpc & { call: ReturnType<typeof vi.fn> } {
  const call = vi.fn(async <T>(method: string, params: unknown) => handler(method, params) as T);
  return { call };
}

describe("GatewayPersonalAgentProvisioner", () => {
  it("rejects a blank workspace root at startup", () => {
    const rpc = createRpc((method) => {
      throw new Error(`unexpected method: ${method}`);
    });

    expect(() => new GatewayPersonalAgentProvisioner({ rpc, workspaceRoot: "   " })).toThrow(
      "personal agent workspace root is required",
    );
    expect(rpc.call).not.toHaveBeenCalled();
  });

  it("creates the reserved personal agent in its expected workspace", async () => {
    const workspaceRoot = path.resolve("test-workspaces");
    const workspace = path.join(workspaceRoot, "account_name");
    const rpc = createRpc((method) => {
      if (method === "agents.list") {
        return { agents: [] };
      }
      if (method === "agents.create") {
        return { ok: true, agentId: "account_name", workspace };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const provisioner = new GatewayPersonalAgentProvisioner({ rpc, workspaceRoot });

    await provisioner.provisionOrRefresh(request());

    expect(rpc.call).toHaveBeenNthCalledWith(1, "agents.list", {});
    expect(rpc.call).toHaveBeenNthCalledWith(2, "agents.create", {
      name: "account_name",
      workspace,
    });
  });

  it("does no Gateway discovery or mutation after activation", async () => {
    const rpc = createRpc((method) => {
      throw new Error(`unexpected method: ${method}`);
    });
    const provisioner = new GatewayPersonalAgentProvisioner({
      rpc,
      workspaceRoot: path.resolve("test-workspaces"),
    });

    await provisioner.provisionOrRefresh(
      request({ binding: { ...request().binding, state: "active" }, createdBinding: false }),
    );

    expect(rpc.call).not.toHaveBeenCalled();
  });

  it("fails closed instead of adopting an agent with another workspace", async () => {
    const workspaceRoot = path.resolve("test-workspaces");
    const rpc = createRpc(() => ({
      agents: [{ id: "account_name", workspace: path.resolve("other-workspace") }],
    }));
    const provisioner = new GatewayPersonalAgentProvisioner({ rpc, workspaceRoot });

    await expect(provisioner.provisionOrRefresh(request())).rejects.toThrow(
      "Gateway agent workspace mismatch",
    );
    expect(rpc.call).toHaveBeenCalledOnce();
  });

  it("adopts a concurrent create only after exact id and workspace verification", async () => {
    const workspaceRoot = path.resolve("test-workspaces");
    const workspace = path.join(workspaceRoot, "account_name");
    let listCount = 0;
    const rpc = createRpc((method) => {
      if (method === "agents.list") {
        listCount += 1;
        return { agents: listCount === 1 ? [] : [{ id: "account_name", workspace }] };
      }
      if (method === "agents.create") {
        throw new GatewayAdminRpcError("agent already exists", "INVALID_REQUEST", 400);
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const provisioner = new GatewayPersonalAgentProvisioner({ rpc, workspaceRoot });

    await expect(provisioner.provisionOrRefresh(request())).resolves.toBeUndefined();
    expect(listCount).toBe(2);
  });

  it("rejects agent ids outside the upstream canonical contract before RPC", async () => {
    const rpc = createRpc((method) => {
      throw new Error(`unexpected method: ${method}`);
    });
    const provisioner = new GatewayPersonalAgentProvisioner({
      rpc,
      workspaceRoot: path.resolve("test-workspaces"),
    });
    const invalid = request({
      binding: { ...request().binding, agentId: `agent-${"x".repeat(64)}` },
    });

    await expect(provisioner.provisionOrRefresh(invalid)).rejects.toThrow(
      "invalid personal agent id",
    );
    expect(rpc.call).not.toHaveBeenCalled();
  });

  it("rejects agent ids with non-canonical whitespace before RPC", async () => {
    const rpc = createRpc((method) => {
      throw new Error(`unexpected method: ${method}`);
    });
    const provisioner = new GatewayPersonalAgentProvisioner({
      rpc,
      workspaceRoot: path.resolve("test-workspaces"),
    });
    const invalid = request({
      binding: { ...request().binding, agentId: " account_name " },
    });

    await expect(provisioner.provisionOrRefresh(invalid)).rejects.toThrow(
      "invalid personal agent id",
    );
    expect(rpc.call).not.toHaveBeenCalled();
  });
});
