import path from "node:path";
import { describe, expect, it, vi, type Mock } from "vitest";
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

function createRpc(handler: (method: string, params: unknown) => unknown): {
  rpc: GatewayAdminRpc;
  call: Mock<(method: string, params: unknown) => Promise<unknown>>;
} {
  const call = vi.fn(async (method: string, params: unknown) => handler(method, params));
  const rpc: GatewayAdminRpc = {
    async call<T>(method: string, params: unknown): Promise<T> {
      return (await call(method, params)) as T;
    },
  };
  return { rpc, call };
}

function createProfileSeedResponder(workspace: string) {
  return {
    handle(method: string, params: unknown): unknown {
      if (method === "platformclaw.profile.seed") {
        const payload = params as { content: string };
        expect(JSON.parse(payload.content)).toMatchObject({
          schema: "platformclaw.employee-profile.v1",
          profile: { employeeId: "employee-1" },
        });
        return {
          ok: true,
          agentId: "account_name",
          workspace,
          created: true,
        };
      }
      return undefined;
    },
  };
}

describe("GatewayPersonalAgentProvisioner", () => {
  it("rejects a blank workspace root at startup", () => {
    const { rpc, call } = createRpc((method) => {
      throw new Error(`unexpected method: ${method}`);
    });

    expect(() => new GatewayPersonalAgentProvisioner({ rpc, workspaceRoot: "   " })).toThrow(
      "personal agent workspace root is required",
    );
    expect(call).not.toHaveBeenCalled();
  });

  it("creates the reserved personal agent in its expected workspace", async () => {
    const workspaceRoot = path.resolve("test-workspaces");
    const workspace = path.join(workspaceRoot, "account_name");
    const profileSeed = createProfileSeedResponder(workspace);
    const { rpc, call } = createRpc((method, params) => {
      if (method === "agents.list") {
        return { agents: [] };
      }
      if (method === "agents.create") {
        return { ok: true, agentId: "account_name", workspace };
      }
      const fileResponse = profileSeed.handle(method, params);
      if (fileResponse) {
        return fileResponse;
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const provisioner = new GatewayPersonalAgentProvisioner({ rpc, workspaceRoot });

    await provisioner.provisionOrRefresh(request());

    expect(call).toHaveBeenNthCalledWith(1, "agents.list", {});
    expect(call).toHaveBeenNthCalledWith(2, "agents.create", {
      name: "account_name",
      workspace,
    });
    expect(call).toHaveBeenNthCalledWith(
      3,
      "platformclaw.profile.seed",
      expect.objectContaining({
        agentId: "account_name",
        workspace,
        content: expect.stringContaining('"employeeId": "employee-1"'),
      }),
    );
  });

  it("does no Gateway discovery or mutation after activation", async () => {
    const { rpc, call } = createRpc((method) => {
      throw new Error(`unexpected method: ${method}`);
    });
    const provisioner = new GatewayPersonalAgentProvisioner({
      rpc,
      workspaceRoot: path.resolve("test-workspaces"),
    });

    await provisioner.provisionOrRefresh(
      request({ binding: { ...request().binding, state: "active" }, createdBinding: false }),
    );

    expect(call).not.toHaveBeenCalled();
  });

  it("fails closed instead of adopting an agent with another workspace", async () => {
    const workspaceRoot = path.resolve("test-workspaces");
    const { rpc, call } = createRpc(() => ({
      agents: [{ id: "account_name", workspace: path.resolve("other-workspace") }],
    }));
    const provisioner = new GatewayPersonalAgentProvisioner({ rpc, workspaceRoot });

    await expect(provisioner.provisionOrRefresh(request())).rejects.toThrow(
      "Gateway agent workspace mismatch",
    );
    expect(call).toHaveBeenCalledOnce();
  });

  it("adopts a concurrent create only after exact id and workspace verification", async () => {
    const workspaceRoot = path.resolve("test-workspaces");
    const workspace = path.join(workspaceRoot, "account_name");
    const profileSeed = createProfileSeedResponder(workspace);
    let listCount = 0;
    const { rpc } = createRpc((method, params) => {
      if (method === "agents.list") {
        listCount += 1;
        return { agents: listCount === 1 ? [] : [{ id: "account_name", workspace }] };
      }
      if (method === "agents.create") {
        throw new GatewayAdminRpcError("agent already exists", "INVALID_REQUEST", 400);
      }
      const fileResponse = profileSeed.handle(method, params);
      if (fileResponse) {
        return fileResponse;
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const provisioner = new GatewayPersonalAgentProvisioner({ rpc, workspaceRoot });

    await expect(provisioner.provisionOrRefresh(request())).resolves.toBeUndefined();
    expect(listCount).toBe(2);
  });

  it("fails closed when the profile seed response points at another workspace", async () => {
    const workspaceRoot = path.resolve("test-workspaces");
    const workspace = path.join(workspaceRoot, "account_name");
    const call = vi.fn(async (method: string, _params: unknown) => {
      if (method === "agents.list") {
        return { agents: [{ id: "account_name", workspace }] };
      }
      if (method === "platformclaw.profile.seed") {
        return {
          ok: true,
          agentId: "account_name",
          workspace: path.resolve("other-workspace"),
          created: true,
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const provisioner = new GatewayPersonalAgentProvisioner({
      rpc: {
        call: async <T>(method: string, params: unknown) => (await call(method, params)) as T,
      },
      workspaceRoot,
    });

    await expect(provisioner.provisionOrRefresh(request())).rejects.toThrow(
      "Gateway agent workspace mismatch",
    );
  });

  it("rejects agent ids outside the upstream canonical contract before RPC", async () => {
    const { rpc, call } = createRpc((method) => {
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
    expect(call).not.toHaveBeenCalled();
  });

  it("rejects agent ids with non-canonical whitespace before RPC", async () => {
    const { rpc, call } = createRpc((method) => {
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
    expect(call).not.toHaveBeenCalled();
  });
});
