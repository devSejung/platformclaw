import type { ControlPlaneStore, KnoxRoomAgentBinding, PlatformUser } from "./contracts.js";

export interface KnoxRoomAgentProvisioner {
  provision(binding: KnoxRoomAgentBinding): Promise<void>;
}

export type KnoxRouteResolution =
  | {
      status: "resolved";
      agentId: string;
      sessionKey: string;
      senderLinked: boolean;
      executionTarget: "platform_server" | "assigned_vm" | null;
    }
  | { status: "login-required" }
  | { status: "room-disabled" }
  | { status: "agent-unavailable" };

/** Owns identity-backed DM routing and idempotent Knox room-agent provisioning. */
export class KnoxRoutingService {
  private readonly roomProvisioning = new Map<string, Promise<KnoxRoomAgentBinding>>();

  constructor(
    private readonly options: {
      store: ControlPlaneStore;
      roomProvisioner: KnoxRoomAgentProvisioner;
      buildAgentMainSessionKey: (params: { agentId: string }) => string;
      now?: () => number;
    },
  ) {}

  async resolve(params: {
    accountId: string;
    conversationType: "dm" | "room";
    conversationId: string;
    knoxUserId: string;
  }): Promise<KnoxRouteResolution> {
    const accountId = requireValue(params.accountId, "accountId");
    const conversationId = requireValue(params.conversationId, "conversationId");
    const knoxUserId = requireValue(params.knoxUserId, "knoxUserId");
    if (params.conversationType === "dm") {
      const route = await this.options.store.resolveAuthenticatedKnoxDmRoute({
        accountId: knoxUserId,
      });
      if (route.status === "user-not-found") {
        return { status: "login-required" };
      }
      if (route.status !== "resolved") {
        return { status: "agent-unavailable" };
      }
      return {
        status: "resolved",
        agentId: route.binding.agentId,
        sessionKey: route.sessionKey,
        senderLinked: true,
        executionTarget: route.executionTarget,
      };
    }

    const binding = await this.provisionRoom({ accountId, roomId: conversationId });
    if (binding.state === "disabled") {
      return { status: "room-disabled" };
    }
    if (binding.state !== "active") {
      return { status: "agent-unavailable" };
    }
    const sender = await this.options.store.getUserByAccountId(knoxUserId);
    return {
      status: "resolved",
      agentId: binding.agentId,
      sessionKey: this.options.buildAgentMainSessionKey({ agentId: binding.agentId }),
      senderLinked: isActiveUser(sender),
      executionTarget: null,
    };
  }

  private provisionRoom(params: { accountId: string; roomId: string }) {
    const key = `${params.accountId}\0${params.roomId}`;
    const existing = this.roomProvisioning.get(key);
    if (existing) {
      return existing;
    }
    const task = this.runRoomProvisioning(params);
    this.roomProvisioning.set(key, task);
    const cleanup = () => {
      if (this.roomProvisioning.get(key) === task) {
        this.roomProvisioning.delete(key);
      }
    };
    void task.then(cleanup, cleanup);
    return task;
  }

  private async runRoomProvisioning(params: {
    accountId: string;
    roomId: string;
  }): Promise<KnoxRoomAgentBinding> {
    const changedAt = (this.options.now ?? Date.now)();
    const reservation = await this.options.store.reserveKnoxRoomAgent({
      ...params,
      reservedAt: changedAt,
    });
    let binding = reservation.binding;
    if (binding.state === "disabled") {
      return binding;
    }
    if (binding.state === "failed") {
      const transitioned = await this.options.store.transitionAgent({
        bindingId: binding.id,
        state: "provisioning",
        changedAt,
      });
      if (transitioned.kind !== "knox-room") {
        throw new Error("Knox room binding changed kind");
      }
      binding = transitioned;
    }
    try {
      // The binding and Gateway roster have independent lifecycles. Revalidate active
      // bindings so an externally deleted room agent is recreated before dispatch.
      await this.options.roomProvisioner.provision(binding);
      if (binding.state !== "provisioning") {
        return binding;
      }
      const transitioned = await this.options.store.transitionAgent({
        bindingId: binding.id,
        state: "active",
        changedAt,
      });
      if (transitioned.kind !== "knox-room") {
        throw new Error("Knox room binding changed kind");
      }
      return transitioned;
    } catch (error) {
      if (binding.state === "provisioning" || binding.state === "active") {
        await this.options.store.transitionAgent({
          bindingId: binding.id,
          state: "failed",
          changedAt,
          failureCode: "provisioner_error",
        });
      }
      throw error;
    }
  }
}

function requireValue(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${field} is required`);
  }
  return normalized;
}

function isActiveUser(user: PlatformUser | null): boolean {
  return user?.status === "active";
}
