import type { ControlPlaneStore, PersonalAgentBinding, PlatformUser } from "./contracts.js";
import type { PersonalAgentRestartRecoveryResult } from "./personal-agent-provisioner.js";

export type PersonalAgentRestartRecoveryProbe = {
  reconcileAfterRestart(params: {
    user: PlatformUser;
    binding: PersonalAgentBinding;
  }): Promise<PersonalAgentRestartRecoveryResult>;
};

export type RestartReconciliationSummary = {
  found: number;
  activated: number;
  failed: number;
  disabled: number;
};

/** Reconciles persisted bindings with Gateway state before public ingress accepts traffic. */
export class AgentRestartReconciler {
  constructor(
    private readonly options: {
      store: ControlPlaneStore;
      personalAgentProbe: PersonalAgentRestartRecoveryProbe;
      now?: () => number;
    },
  ) {}

  async reconcile(): Promise<RestartReconciliationSummary> {
    const [pending, active] = await Promise.all([
      this.options.store.listAgentBindingsByState("provisioning"),
      this.options.store.listAgentBindingsByState("active"),
    ]);
    // Knox room agents run in the local PlatformClaw workspace and have no
    // Gateway personal-agent ownership contract to revalidate here.
    const bindings = [...pending, ...active.filter((binding) => binding.kind === "personal")];
    const summary: RestartReconciliationSummary = {
      found: bindings.length,
      activated: 0,
      failed: 0,
      disabled: 0,
    };
    for (const binding of bindings) {
      const changedAt = (this.options.now ?? Date.now)();
      if (binding.kind === "knox-room") {
        await this.fail(binding.id, changedAt, "restart_room_runtime_pending");
        summary.failed += 1;
        continue;
      }
      const user = await this.options.store.getUserById(binding.userId);
      if (!user) {
        throw new Error(`personal agent owner missing during restart recovery: ${binding.id}`);
      }
      if (user.status === "disabled") {
        await this.options.store.transitionAgent({
          bindingId: binding.id,
          state: "disabled",
          changedAt,
        });
        summary.disabled += 1;
        continue;
      }
      const result = await this.options.personalAgentProbe.reconcileAfterRestart({ user, binding });
      if (result.status === "active") {
        if (binding.state === "provisioning") {
          await this.options.store.transitionAgent({
            bindingId: binding.id,
            state: "active",
            changedAt,
          });
          summary.activated += 1;
        }
        continue;
      }
      await this.fail(binding.id, changedAt, `restart_${result.reason.replaceAll("-", "_")}`);
      summary.failed += 1;
    }
    return summary;
  }

  private async fail(bindingId: string, changedAt: number, failureCode: string): Promise<void> {
    await this.options.store.transitionAgent({
      bindingId,
      state: "failed",
      changedAt,
      failureCode,
    });
  }
}
